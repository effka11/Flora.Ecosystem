//! Интеграционные тесты кодека: паритет, качество, устойчивость, inter-кадры.

use fvc::metrics::psnr;
use fvc::{Decoder, Encoder, EncoderConfig, Frame};

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
}

/// Синтетический «естественный» кадр: плавные градиенты + структуры + слабый шум.
fn test_frame(w: usize, h: usize, seed: u64) -> Frame {
    let mut f = Frame::new(w, h);
    let mut rng = Lcg(seed);
    let (cx, cy) = ((w / 2) as i64, (h / 2) as i64);
    for y in 0..h {
        for x in 0..w {
            let dx = x as i64 - cx;
            let dy = y as i64 - cy;
            let r2 = dx * dx + dy * dy;
            // Градиент + кольца + диагональные полосы + шум.
            let g = (x * 255 / w) as i64;
            let ring = if (r2 / 97) % 7 < 2 { 60 } else { 0 };
            let stripe = if ((x + 2 * y) / 16) % 5 == 0 { -40 } else { 0 };
            let noise = (rng.next() % 9) as i64 - 4;
            let v = (g / 2 + 80 + ring + stripe + noise).clamp(0, 255);
            f.y.set(x, y, v as u8);
        }
    }
    for y in 0..h / 2 {
        for x in 0..w / 2 {
            f.cb.set(x, y, (100 + (x * 80 / (w / 2))) as u8);
            f.cr.set(x, y, (160 - (y * 60 / (h / 2))) as u8);
        }
    }
    f
}

/// Кадр `base`, сдвинутый на (dx, dy) пикселей (панорама с репликацией краёв).
fn shifted_frame(base: &Frame, dx: i32, dy: i32) -> Frame {
    let (w, h) = (base.width(), base.height());
    let mut f = Frame::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let sx = (x as i32 - dx).clamp(0, w as i32 - 1) as usize;
            let sy = (y as i32 - dy).clamp(0, h as i32 - 1) as usize;
            f.y.set(x, y, base.y.get(sx, sy));
        }
    }
    for y in 0..h / 2 {
        for x in 0..w / 2 {
            let sx = (x as i32 - dx / 2).clamp(0, (w / 2) as i32 - 1) as usize;
            let sy = (y as i32 - dy / 2).clamp(0, (h / 2) as i32 - 1) as usize;
            f.cb.set(x, y, base.cb.get(sx, sy));
            f.cr.set(x, y, base.cr.get(sx, sy));
        }
    }
    f
}

fn cfg(w: u32, h: u32, qp: u8) -> EncoderConfig {
    EncoderConfig {
        width: w,
        height: h,
        qp,
        loop_filter: true,
        keyint: 1,
    }
}

fn cfg_gop(w: u32, h: u32, qp: u8, keyint: u32) -> EncoderConfig {
    EncoderConfig {
        width: w,
        height: h,
        qp,
        loop_filter: true,
        keyint,
    }
}

/// Ключевой инвариант: выход декодера бит-в-бит равен реконструкции энкодера.
#[test]
fn decoder_matches_encoder_reconstruction() {
    for &(w, h) in &[(64usize, 64usize), (128, 96), (200, 120), (72, 56)] {
        for &qp in &[8u8, 28, 48] {
            let src = test_frame(w, h, 0xF10A + qp as u64);
            let mut enc = Encoder::new(cfg(w as u32, h as u32, qp)).unwrap();
            let packet = enc.encode_frame(&src).unwrap();
            let mut dec = Decoder::new();
            let out = dec.decode_frame(&packet.data).unwrap();
            assert_eq!(&out, enc.last_recon(), "recon mismatch {w}x{h} qp={qp}");
        }
    }
}

/// Паритет на последовательности с движением: каждый кадр GOP (ключ + P)
/// бит-в-бит совпадает у энкодера и декодера.
#[test]
fn multi_frame_parity_with_motion() {
    let (w, h) = (128usize, 96usize);
    let base = test_frame(w, h, 0xBEEF);
    for &qp in &[16u8, 36] {
        let mut enc = Encoder::new(cfg_gop(w as u32, h as u32, qp, 4)).unwrap();
        let mut dec = Decoder::new();
        for (i, &(dx, dy)) in [(0, 0), (2, 1), (5, 3), (7, 4), (10, 6), (12, 8), (13, 9), (15, 10)]
            .iter()
            .enumerate()
        {
            let src = shifted_frame(&base, dx, dy);
            let packet = enc.encode_frame(&src).unwrap();
            assert_eq!(packet.keyframe, i % 4 == 0, "keyint schedule frame {i}");
            let out = dec.decode_frame(&packet.data).unwrap();
            assert_eq!(&out, enc.last_recon(), "frame {i} qp={qp}");
        }
    }
}

/// P-кадры существенно меньше ключевых на панорамирующем контенте,
/// а качество не проседает.
#[test]
fn inter_frames_pay_off_on_panning() {
    let (w, h) = (192usize, 128usize);
    let base = test_frame(w, h, 5150);
    let mut enc = Encoder::new(cfg_gop(w as u32, h as u32, 30, 100)).unwrap();
    let mut dec = Decoder::new();
    let mut key_size = 0usize;
    let mut p_sizes = Vec::new();
    for i in 0..6 {
        let src = shifted_frame(&base, 3 * i as i32, 2 * i as i32);
        let packet = enc.encode_frame(&src).unwrap();
        if packet.keyframe {
            key_size = packet.data.len();
        } else {
            p_sizes.push(packet.data.len());
        }
        let out = dec.decode_frame(&packet.data).unwrap();
        let p = psnr(&src, &out);
        assert!(p.overall > 33.0, "frame {i} psnr {:.2}", p.overall);
    }
    let avg_p = p_sizes.iter().sum::<usize>() / p_sizes.len();
    assert!(
        avg_p * 4 < key_size,
        "P-frames must be at least 4x smaller: key={key_size}, avg P={avg_p}"
    );
}

/// Статичная сцена: P-кадры почти пустые (skip-блоки).
#[test]
fn static_scene_p_frames_are_tiny() {
    let (w, h) = (128usize, 128usize);
    let src = test_frame(w, h, 314);
    let mut enc = Encoder::new(cfg_gop(w as u32, h as u32, 28, 50)).unwrap();
    let mut dec = Decoder::new();
    let first = enc.encode_frame(&src).unwrap();
    dec.decode_frame(&first.data).unwrap();
    for i in 1..4 {
        let packet = enc.encode_frame(&src).unwrap();
        assert!(!packet.keyframe);
        assert!(
            packet.data.len() < 64,
            "static P-frame {i} took {} bytes",
            packet.data.len()
        );
        let out = dec.decode_frame(&packet.data).unwrap();
        assert_eq!(&out, enc.last_recon(), "frame {i}");
    }
}

/// P-кадр без предшествующего ключевого: серая опора, детерминированный
/// результат, отсутствие паники.
#[test]
fn p_frame_without_reference_uses_grey() {
    let (w, h) = (64usize, 64usize);
    let src = test_frame(w, h, 77);
    let mut enc = Encoder::new(cfg_gop(w as u32, h as u32, 30, 2)).unwrap();
    let _key = enc.encode_frame(&src).unwrap();
    let p = enc.encode_frame(&shifted_frame(&src, 1, 1)).unwrap();
    assert!(!p.keyframe);

    let mut fresh = Decoder::new();
    let a = fresh.decode_frame(&p.data).unwrap();
    let mut fresh2 = Decoder::new();
    let b = fresh2.decode_frame(&p.data).unwrap();
    assert_eq!(a, b, "grey-reference decode must be deterministic");
}

/// Качество падает монотонно с qp, а размер уменьшается.
#[test]
fn qp_controls_rate_and_quality() {
    let (w, h) = (192usize, 128usize);
    let src = test_frame(w, h, 7);
    let mut prev_size = usize::MAX;
    let mut prev_psnr = f64::INFINITY;
    for &qp in &[4u8, 16, 28, 40, 52] {
        let mut enc = Encoder::new(cfg(w as u32, h as u32, qp)).unwrap();
        let packet = enc.encode_frame(&src).unwrap();
        let mut dec = Decoder::new();
        let out = dec.decode_frame(&packet.data).unwrap();
        let p = psnr(&src, &out);
        assert!(
            packet.data.len() < prev_size,
            "size must shrink with qp (qp={qp})"
        );
        assert!(
            p.overall < prev_psnr + 0.01,
            "psnr must not grow with qp (qp={qp})"
        );
        prev_size = packet.data.len();
        prev_psnr = p.overall;
    }
    // Санити-порог качества на низком qp.
    let mut enc = Encoder::new(cfg(w as u32, h as u32, 8)).unwrap();
    let packet = enc.encode_frame(&src).unwrap();
    let out = Decoder::new().decode_frame(&packet.data).unwrap();
    assert!(psnr(&src, &out).overall > 40.0);
}

/// Декодер не паникует на порче каждого байта потока (ключ и P-кадр).
#[test]
fn decoder_survives_corruption() {
    let (w, h) = (96usize, 64usize);
    let src = test_frame(w, h, 99);
    let mut enc = Encoder::new(cfg_gop(w as u32, h as u32, 30, 2)).unwrap();
    let key = enc.encode_frame(&src).unwrap();
    let p = enc.encode_frame(&shifted_frame(&src, 2, 1)).unwrap();
    assert!(!p.keyframe);

    for packet in [&key, &p] {
        let mut dec = Decoder::new();
        dec.decode_frame(&key.data).unwrap();
        // Порча одного байта во всех позициях.
        for i in 0..packet.data.len() {
            let mut bad = packet.data.clone();
            bad[i] ^= 0x5A;
            let _ = dec.decode_frame(&bad); // Err или мусорный кадр — но не паника
        }
        // Обрезка до всех длин (шаг 7 для скорости).
        for cut in (0..packet.data.len()).step_by(7) {
            let _ = dec.decode_frame(&packet.data[..cut]);
        }
    }
    // Случайный мусор.
    let mut dec = Decoder::new();
    let mut rng = Lcg(3);
    for len in [0usize, 1, 7, 64, 4096] {
        let junk: Vec<u8> = (0..len).map(|_| (rng.next() & 0xFF) as u8).collect();
        let _ = dec.decode_frame(&junk);
    }
}

/// Мини-fuzz: многобайтовые мутации валидного GOP-потока и потоки с валидным
/// заголовком + случайным телом. Декодер обязан пережить всё.
#[test]
fn decoder_fuzz_mutations() {
    let (w, h) = (128usize, 96usize);
    let src = test_frame(w, h, 41);
    let mut enc = Encoder::new(cfg_gop(w as u32, h as u32, 36, 3)).unwrap();
    let key = enc.encode_frame(&src).unwrap();
    let p1 = enc.encode_frame(&shifted_frame(&src, 3, 2)).unwrap();
    let p2 = enc.encode_frame(&shifted_frame(&src, 6, 4)).unwrap();
    let mut rng = Lcg(0xFA2242);

    // 300 случайных мутаций на пакет: 1..16 байтовых правок + случайная обрезка.
    for packet in [&key, &p1, &p2] {
        let mut dec = Decoder::new();
        dec.decode_frame(&key.data).unwrap();
        for _ in 0..100 {
            let mut bad = packet.data.clone();
            for _ in 0..(rng.next() % 16 + 1) {
                let pos = (rng.next() as usize) % bad.len();
                bad[pos] = (rng.next() & 0xFF) as u8;
            }
            if rng.next().is_multiple_of(4) {
                let cut = (rng.next() as usize) % bad.len();
                bad.truncate(cut);
            }
            let _ = dec.decode_frame(&bad);
        }
    }

    // Валидный заголовок (ключ и P) + мусорное арифметическое тело разных длин.
    let mut dec = Decoder::new();
    dec.decode_frame(&key.data).unwrap();
    for header in [&key.data[..7], &p1.data[..7]] {
        for len in [0usize, 1, 13, 200, 5000] {
            let mut stream = header.to_vec();
            stream.extend((0..len).map(|_| (rng.next() & 0xFF) as u8));
            let _ = dec.decode_frame(&stream);
        }
    }
}

/// Смена размеров внутри потока: на P-кадре — ошибка, на ключевом — допустима.
#[test]
fn dimension_change_rules() {
    let small = test_frame(64, 64, 1);
    let big = test_frame(128, 128, 2);

    let mut enc_small = Encoder::new(cfg_gop(64, 64, 30, 2)).unwrap();
    let mut enc_big = Encoder::new(cfg_gop(128, 128, 30, 2)).unwrap();
    let key_small = enc_small.encode_frame(&small).unwrap();
    let key_big = enc_big.encode_frame(&big).unwrap();
    let p_small = enc_small.encode_frame(&shifted_frame(&small, 1, 0)).unwrap();
    assert!(!p_small.keyframe);

    let mut dec = Decoder::new();
    dec.decode_frame(&key_big.data).unwrap();
    // P-кадр 64×64 после ключа 128×128 → структурная ошибка.
    assert!(dec.decode_frame(&p_small.data).is_err());
    // Новый ключ другого размера — легально.
    dec.decode_frame(&key_small.data).unwrap();
    dec.decode_frame(&p_small.data).unwrap();
}

/// Кодек корректен на минимальном (8×8) и вытянутых кадрах, включая P-кадры.
#[test]
fn extreme_dimensions_roundtrip() {
    for &(w, h) in &[(8usize, 8usize), (8, 512), (512, 8), (16, 8)] {
        let src = test_frame(w, h, w as u64 * 31 + h as u64);
        let mut enc = Encoder::new(cfg_gop(w as u32, h as u32, 30, 2)).unwrap();
        let packet = enc.encode_frame(&src).unwrap();
        let mut dec = Decoder::new();
        let out = dec.decode_frame(&packet.data).unwrap();
        assert_eq!(&out, enc.last_recon(), "{w}x{h} key");
        let p = enc.encode_frame(&shifted_frame(&src, 1, 1)).unwrap();
        let out = dec.decode_frame(&p.data).unwrap();
        assert_eq!(&out, enc.last_recon(), "{w}x{h} P");
    }
}

/// Кодирование детерминировано: два прогона дают одинаковые байты (ключ и P).
#[test]
fn encoding_is_deterministic() {
    let (w, h) = (128usize, 72usize);
    let f0 = test_frame(w, h, 1234);
    let f1 = shifted_frame(&f0, 4, 2);
    let run = || {
        let mut enc = Encoder::new(cfg_gop(w as u32, h as u32, 24, 8)).unwrap();
        let a = enc.encode_frame(&f0).unwrap();
        let b = enc.encode_frame(&f1).unwrap();
        (a.data, b.data)
    };
    assert_eq!(run(), run());
}

/// Плоский кадр сжимается в считанные байты на мегапиксель.
#[test]
fn flat_frame_compresses_hard() {
    let (w, h) = (256usize, 256usize);
    let mut src = Frame::new(w, h);
    src.y.data_mut().fill(90);
    src.cb.data_mut().fill(120);
    src.cr.data_mut().fill(140);
    let mut enc = Encoder::new(cfg(w as u32, h as u32, 20)).unwrap();
    let packet = enc.encode_frame(&src).unwrap();
    // 256×256 (98 304 байта YUV) — ждём < 300 байт.
    assert!(
        packet.data.len() < 300,
        "flat frame took {} bytes",
        packet.data.len()
    );
    let out = Decoder::new().decode_frame(&packet.data).unwrap();
    assert!(psnr(&src, &out).overall > 46.0);
}

/// Конфигурационные ошибки ловятся.
#[test]
fn config_validation() {
    assert!(Encoder::new(cfg(0, 64, 10)).is_err());
    assert!(Encoder::new(cfg(64, 60, 10)).is_err()); // высота не кратна 8
    assert!(Encoder::new(cfg(64, 64, 64)).is_err()); // qp вне диапазона
    assert!(Encoder::new(cfg_gop(64, 64, 10, 0)).is_err()); // keyint = 0
    assert!(
        Encoder::new(EncoderConfig {
            width: 20_000,
            height: 64,
            qp: 1,
            loop_filter: false,
            keyint: 1,
        })
        .is_err()
    );
}

/// Несовпадение кадра и конфигурации — ошибка, а не паника.
#[test]
fn frame_size_mismatch_is_error() {
    let mut enc = Encoder::new(cfg(64, 64, 10)).unwrap();
    let wrong = Frame::new(128, 64);
    assert!(enc.encode_frame(&wrong).is_err());
}
