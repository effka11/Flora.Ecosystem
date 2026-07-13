//! Сквозные тесты кодека: качество, битрейт, детерминизм, устойчивость
//! к повреждённым пакетам, PLC.

use fac_core::mdct::Mdct;
use fac_core::{Config, Decoder, Encoder, FRAME_N, bands};

fn xorshift(state: &mut u32) -> f32 {
    *state ^= *state << 13;
    *state ^= *state >> 17;
    *state ^= *state << 5;
    (*state as f32 / 2f32.powi(31)) - 1.0
}

fn sine(rate: u32, ch: usize, secs: f32, freq: f32, amp: f32) -> Vec<f32> {
    let total = (secs * rate as f32) as usize;
    let mut out = Vec::with_capacity(total * ch);
    for j in 0..total {
        let t = j as f32 / rate as f32;
        for c in 0..ch {
            let phase = 2.0 * core::f32::consts::PI * freq * t + c as f32 * 0.31;
            out.push(amp * phase.sin());
        }
    }
    out
}

fn white_noise(rate: u32, ch: usize, secs: f32, amp: f32) -> Vec<f32> {
    let total = (secs * rate as f32) as usize;
    let mut state = 0xDEAD_BEEFu32;
    (0..total * ch)
        .map(|_| amp * xorshift(&mut state))
        .collect()
}

/// Музыкоподобный сигнал: аккорд с тремоло + фильтрованный шум + щелчки.
fn mix_signal(rate: u32, ch: usize, secs: f32) -> Vec<f32> {
    let total = (secs * rate as f32) as usize;
    let mut out = Vec::with_capacity(total * ch);
    let mut state = 0x1357_9BDFu32;
    let mut lp = [0f32; 2];
    for j in 0..total {
        let t = j as f32 / rate as f32;
        let trem = 0.7 + 0.3 * (2.0 * core::f32::consts::PI * 3.0 * t).sin();
        for (c, lp_c) in lp.iter_mut().enumerate().take(ch) {
            let det = 1.0 + 0.001 * c as f32;
            let chord = 0.30 * (2.0 * core::f32::consts::PI * 220.0 * det * t).sin()
                + 0.22 * (2.0 * core::f32::consts::PI * 277.18 * det * t).sin()
                + 0.18 * (2.0 * core::f32::consts::PI * 329.63 * det * t + c as f32).sin();
            *lp_c = 0.85 * *lp_c + 0.15 * xorshift(&mut state);
            let click_phase = j % (rate as usize / 2);
            let click = if click_phase < 240 {
                0.35 * xorshift(&mut state) * (-(click_phase as f32) / 40.0).exp()
            } else {
                0.0
            };
            out.push((chord * trem + 0.10 * *lp_c + click).clamp(-0.95, 0.95));
        }
    }
    out
}

fn snr_db(reference: &[f32], decoded: &[f32]) -> f64 {
    assert_eq!(reference.len(), decoded.len());
    let mut sig = 0f64;
    let mut err = 0f64;
    for (&a, &b) in reference.iter().zip(decoded) {
        sig += f64::from(a) * f64::from(a);
        let e = f64::from(a) - f64::from(b);
        err += e * e;
    }
    if err == 0.0 {
        return f64::INFINITY;
    }
    10.0 * (sig / err).log10()
}

/// Кодирует и декодирует поток; возвращает (выровненный выход, средние биты на кадр).
fn roundtrip(cfg: Config, pcm: &[f32]) -> (Vec<f32>, f64) {
    let ch = cfg.channels as usize;
    let mut enc = Encoder::new(cfg).unwrap();
    let mut dec = Decoder::new(cfg.sample_rate, cfg.channels).unwrap();
    let total = pcm.len() / ch;
    let hops = total.div_ceil(FRAME_N);
    let mut out = Vec::new();
    let mut bits = 0u64;
    for h in 0..=hops {
        let mut chunk = vec![0f32; FRAME_N * ch];
        if h < hops {
            let start = h * FRAME_N;
            let len = (total - start).min(FRAME_N);
            chunk[..len * ch].copy_from_slice(&pcm[start * ch..(start + len) * ch]);
        }
        let pkt = enc.encode_frame(&chunk).unwrap();
        bits += pkt.len() as u64 * 8;
        out.extend(dec.decode_frame(&pkt).unwrap());
    }
    let aligned = out[FRAME_N * ch..][..pcm.len()].to_vec();
    (aligned, bits as f64 / (hops + 1) as f64)
}

#[test]
fn sine_mono_96k_has_high_snr() {
    let cfg = Config {
        sample_rate: 48_000,
        channels: 1,
        bitrate_bps: 96_000,
    };
    let pcm = sine(48_000, 1, 0.5, 440.0, 0.5);
    let (dec, _) = roundtrip(cfg, &pcm);
    let snr = snr_db(&pcm, &dec);
    println!("sine mono 96k: SNR = {snr:.1} dB");
    assert!(snr > 35.0, "SNR too low: {snr:.1} dB");
}

#[test]
fn mix_stereo_96k_quality_and_bitrate() {
    let cfg = Config {
        sample_rate: 48_000,
        channels: 2,
        bitrate_bps: 96_000,
    };
    let pcm = mix_signal(48_000, 2, 0.5);
    let (dec, avg_bits) = roundtrip(cfg, &pcm);
    let snr = snr_db(&pcm, &dec);
    let budget = 96_000.0 * FRAME_N as f64 / 48_000.0;
    println!(
        "mix stereo 96k: SNR = {snr:.1} dB, avg bits/frame = {avg_bits:.0} (budget {budget:.0})"
    );
    assert!(snr > 22.0, "SNR too low: {snr:.1} dB");
    // Форма гарантированно в бюджете; +8 бит — выравнивание пакета до байта.
    assert!(avg_bits <= budget + 8.0, "budget overrun: {avg_bits}");
    assert!(avg_bits >= budget * 0.35, "budget underrun: {avg_bits}");
}

/// Средняя лог-спектральная дистанция по полосам (дБ) между сигналами,
/// по всем полным окнам; тихие полосы (< −60 дБFS) пропускаются.
fn band_lsd_db(reference: &[f32], decoded: &[f32], ch: usize) -> f64 {
    let m = Mdct::new(FRAME_N);
    let frames = reference.len() / ch / FRAME_N - 1;
    let mut coeffs_a = vec![0f32; FRAME_N];
    let mut coeffs_b = vec![0f32; FRAME_N];
    let mut sum = 0f64;
    let mut count = 0u64;
    for c in 0..ch {
        for f in 0..frames {
            let window = |src: &[f32]| -> Vec<f32> {
                (0..2 * FRAME_N)
                    .map(|j| src[(f * FRAME_N + j) * ch + c])
                    .collect()
            };
            m.forward(&window(reference), &mut coeffs_a);
            m.forward(&window(decoded), &mut coeffs_b);
            for b in 0..bands::NUM_BANDS {
                let e = |x: &[f32]| -> f64 {
                    x[bands::band_range(b)]
                        .iter()
                        .map(|&v| f64::from(v) * f64::from(v))
                        .sum::<f64>()
                        + 1e-10
                };
                let ea = e(&coeffs_a);
                if 10.0 * ea.log10() < -60.0 {
                    continue;
                }
                sum += (10.0 * (ea / e(&coeffs_b)).log10()).abs();
                count += 1;
            }
        }
    }
    sum / count as f64
}

#[test]
fn noise_stereo_128k_preserves_band_energies() {
    // Waveform-SNR для шума не показателен: при нехватке бит формы кодек честно
    // переходит на noise-fill (другая реализация того же шума). Перцептивно
    // важно сохранение энергий полос — его и проверяем.
    let cfg = Config {
        sample_rate: 48_000,
        channels: 2,
        bitrate_bps: 128_000,
    };
    let pcm = white_noise(48_000, 2, 0.4, 0.3);
    let (dec, _) = roundtrip(cfg, &pcm);
    let lsd = band_lsd_db(&pcm, &dec, 2);
    let snr = snr_db(&pcm, &dec);
    println!("noise stereo 128k: band-LSD = {lsd:.2} dB (SNR = {snr:.1} dB, справочно)");
    assert!(lsd < 1.0, "band energies drifted: {lsd:.2} dB");
}

#[test]
fn silence_stays_silent() {
    let cfg = Config {
        sample_rate: 48_000,
        channels: 2,
        bitrate_bps: 64_000,
    };
    let pcm = vec![0f32; 48_000];
    let (dec, avg_bits) = roundtrip(cfg, &pcm);
    let rms = (dec
        .iter()
        .map(|&x| f64::from(x) * f64::from(x))
        .sum::<f64>()
        / dec.len() as f64)
        .sqrt();
    println!("silence: RMS = {rms:.2e}, avg bits/frame = {avg_bits:.0}");
    assert!(rms < 1e-3, "silence leaked energy: rms={rms}");
}

#[test]
fn encoding_is_deterministic() {
    let cfg = Config {
        sample_rate: 48_000,
        channels: 2,
        bitrate_bps: 64_000,
    };
    let pcm = mix_signal(48_000, 2, 0.2);
    let encode_all = || {
        let mut enc = Encoder::new(cfg).unwrap();
        let mut packets = Vec::new();
        for chunk in pcm.chunks_exact(FRAME_N * 2) {
            packets.push(enc.encode_frame(chunk).unwrap());
        }
        packets
    };
    let a = encode_all();
    let b = encode_all();
    assert_eq!(a, b, "encoder must be deterministic");

    let decode_all = |packets: &[Vec<u8>]| {
        let mut dec = Decoder::new(48_000, 2).unwrap();
        packets
            .iter()
            .flat_map(|p| dec.decode_frame(p).unwrap())
            .collect::<Vec<f32>>()
    };
    assert_eq!(decode_all(&a), decode_all(&b));
}

#[test]
fn truncated_and_corrupt_packets_do_not_panic() {
    let cfg = Config {
        sample_rate: 48_000,
        channels: 2,
        bitrate_bps: 96_000,
    };
    let pcm = mix_signal(48_000, 2, 0.05);
    let mut enc = Encoder::new(cfg).unwrap();
    let packet = enc.encode_frame(&pcm[..FRAME_N * 2]).unwrap();

    // decode_frame не меняет состояние при ошибке — декодер можно переиспользовать.
    let mut dec = Decoder::new(48_000, 2).unwrap();
    for cut in 0..packet.len() {
        let _ = dec.decode_frame(&packet[..cut]);
    }
    // Битфлипы по всему пакету.
    let mut state = 0xABCD_EF01u32;
    for _ in 0..500 {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        let mut bad = packet.clone();
        let byte = state as usize % bad.len();
        bad[byte] ^= 1 << (state >> 29);
        let _ = dec.decode_frame(&bad);
    }
    // Полный мусор.
    let garbage: Vec<u8> = (0..200u32).map(|i| (i * 37 + 11) as u8).collect();
    let _ = dec.decode_frame(&garbage);
    // После всего этого валидный пакет по-прежнему декодируется.
    assert!(dec.decode_frame(&packet).is_ok());
}

#[test]
fn packet_loss_concealment_produces_finite_audio() {
    let cfg = Config {
        sample_rate: 48_000,
        channels: 2,
        bitrate_bps: 96_000,
    };
    let pcm = mix_signal(48_000, 2, 0.1);
    let mut enc = Encoder::new(cfg).unwrap();
    let mut dec = Decoder::new(48_000, 2).unwrap();
    let p0 = enc.encode_frame(&pcm[..FRAME_N * 2]).unwrap();
    let p1 = enc.encode_frame(&pcm[FRAME_N * 2..FRAME_N * 4]).unwrap();
    dec.decode_frame(&p0).unwrap();
    let lost = dec.decode_lost();
    assert_eq!(lost.len(), FRAME_N * 2);
    assert!(lost.iter().all(|x| x.is_finite()));
    let next = dec.decode_frame(&p1).unwrap();
    assert!(next.iter().all(|x| x.is_finite()));
}

#[test]
fn channel_mode_mismatch_is_rejected() {
    let cfg = Config {
        sample_rate: 48_000,
        channels: 1,
        bitrate_bps: 64_000,
    };
    let mut enc = Encoder::new(cfg).unwrap();
    let packet = enc.encode_frame(&vec![0.1f32; FRAME_N]).unwrap();
    let mut dec_stereo = Decoder::new(48_000, 2).unwrap();
    assert!(dec_stereo.decode_frame(&packet).is_err());
}

#[test]
fn works_at_44100_hz() {
    let cfg = Config {
        sample_rate: 44_100,
        channels: 2,
        bitrate_bps: 96_000,
    };
    let pcm = mix_signal(44_100, 2, 0.3);
    let (dec, avg_bits) = roundtrip(cfg, &pcm);
    let snr = snr_db(&pcm, &dec);
    // Бюджет кадра при 44.1 кГц больше: кадр длиннее по времени (960/44100 с).
    let budget = 96_000.0 * FRAME_N as f64 / 44_100.0;
    println!("mix stereo 96k @44.1: SNR = {snr:.1} dB, avg bits/frame = {avg_bits:.0}");
    assert!(snr > 15.0, "SNR too low: {snr:.1} dB");
    assert!(avg_bits <= budget + 8.0, "budget overrun: {avg_bits}");
}

#[test]
fn invalid_configs_are_rejected() {
    let bad = [
        Config {
            sample_rate: 32_000,
            channels: 1,
            bitrate_bps: 64_000,
        },
        Config {
            sample_rate: 48_000,
            channels: 3,
            bitrate_bps: 64_000,
        },
        Config {
            sample_rate: 48_000,
            channels: 1,
            bitrate_bps: 4_000,
        },
        Config {
            sample_rate: 48_000,
            channels: 1,
            bitrate_bps: 1_000_000,
        },
    ];
    for cfg in bad {
        assert!(Encoder::new(cfg).is_err(), "accepted invalid {cfg:?}");
    }
    assert!(Decoder::new(96_000, 1).is_err());
    assert!(Decoder::new(48_000, 0).is_err());

    let mut enc = Encoder::new(Config {
        sample_rate: 48_000,
        channels: 2,
        bitrate_bps: 96_000,
    })
    .unwrap();
    // Неверная длина PCM-буфера.
    assert!(enc.encode_frame(&vec![0f32; FRAME_N]).is_err());
}

#[test]
fn low_bitrate_parametric_mode_works() {
    // 8 kbps mono: бюджета хватает почти только на энергии — кадр становится
    // параметрическим (noise-fill по энергиям полос). Должен остаться стабильным.
    let cfg = Config {
        sample_rate: 48_000,
        channels: 1,
        bitrate_bps: 8_000,
    };
    let pcm = mix_signal(48_000, 1, 0.3);
    let (dec, avg_bits) = roundtrip(cfg, &pcm);
    println!("8k mono parametric: avg bits/frame = {avg_bits:.0}");
    assert!(dec.iter().all(|x| x.is_finite()));
    let rms = (dec
        .iter()
        .map(|&x| f64::from(x) * f64::from(x))
        .sum::<f64>()
        / dec.len() as f64)
        .sqrt();
    assert!(rms > 1e-4 && rms < 1.0, "implausible output level: {rms}");
}
