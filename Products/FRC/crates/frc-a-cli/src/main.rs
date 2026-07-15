//! Инструмент разработки FRC-A: генерация тестовых сигналов, кодирование,
//! декодирование и roundtrip-метрики. Спецификация: Documents/codecs/FRC-A.md.

use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::PathBuf;

use clap::{Parser, Subcommand, ValueEnum};
use frc_a_core::{Config, Decoder, Encoder, FRAME_N, container};

type CliResult<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Parser)]
#[command(
    name = "frc-a",
    version,
    about = "FRC-A (Flora Relativistic Codec — Audio) — инструмент разработки"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Сгенерировать тестовый WAV (репозиторий не хранит бинарные ассеты)
    Gen {
        #[arg(short, long)]
        output: PathBuf,
        #[arg(long, default_value_t = 5.0)]
        seconds: f32,
        #[arg(long, default_value_t = 48_000)]
        sample_rate: u32,
        #[arg(long, default_value_t = 2)]
        channels: u16,
        #[arg(long, value_enum, default_value_t = Signal::Mix)]
        signal: Signal,
    },
    /// WAV → FRC-A
    Encode {
        #[arg(short, long)]
        input: PathBuf,
        #[arg(short, long)]
        output: PathBuf,
        /// Целевой битрейт, kbps
        #[arg(short, long, default_value_t = 96)]
        bitrate: u32,
    },
    /// FRC-A → WAV (16 бит)
    Decode {
        #[arg(short, long)]
        input: PathBuf,
        #[arg(short, long)]
        output: PathBuf,
    },
    /// Кодирование и декодирование в памяти + метрики качества
    Roundtrip {
        #[arg(short, long)]
        input: PathBuf,
        /// Целевой битрейт, kbps
        #[arg(short, long, default_value_t = 96)]
        bitrate: u32,
        /// Записать декодированный WAV для прослушивания
        #[arg(short, long)]
        output: Option<PathBuf>,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum Signal {
    Sine,
    Sweep,
    Noise,
    Mix,
}

fn main() {
    if let Err(e) = run() {
        eprintln!("frc-a: ошибка: {e}");
        std::process::exit(1);
    }
}

fn run() -> CliResult<()> {
    match Cli::parse().cmd {
        Cmd::Gen {
            output,
            seconds,
            sample_rate,
            channels,
            signal,
        } => generate(&output, seconds, sample_rate, channels, signal),
        Cmd::Encode {
            input,
            output,
            bitrate,
        } => encode(&input, &output, bitrate),
        Cmd::Decode { input, output } => decode(&input, &output),
        Cmd::Roundtrip {
            input,
            bitrate,
            output,
        } => roundtrip(&input, bitrate, output.as_deref()),
    }
}

// ---------- WAV I/O ----------

fn read_wav(path: &std::path::Path) -> CliResult<(Vec<f32>, u32, u16)> {
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<_, _>>()?,
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 * scale))
                .collect::<Result<_, _>>()?
        }
    };
    Ok((samples, spec.sample_rate, spec.channels))
}

fn write_wav_i16(
    path: &std::path::Path,
    samples: &[f32],
    sample_rate: u32,
    channels: u16,
) -> CliResult<()> {
    let spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec)?;
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32_767.0).round() as i16;
        writer.write_sample(v)?;
    }
    writer.finalize()?;
    Ok(())
}

// ---------- Кодирование потока ----------

/// Кодирует PCM в пакеты: все полные/дополненные hop'ы + один flush-кадр.
fn encode_packets(cfg: Config, pcm: &[f32]) -> CliResult<Vec<Vec<u8>>> {
    let ch = cfg.channels as usize;
    let total = pcm.len() / ch;
    let hops = total.div_ceil(FRAME_N);
    let mut enc = Encoder::new(cfg)?;
    let mut packets = Vec::with_capacity(hops + 1);
    for h in 0..=hops {
        let mut chunk = vec![0f32; FRAME_N * ch];
        if h < hops {
            let start = h * FRAME_N;
            let len = (total - start).min(FRAME_N);
            chunk[..len * ch].copy_from_slice(&pcm[start * ch..(start + len) * ch]);
        }
        packets.push(enc.encode_frame(&chunk)?);
    }
    Ok(packets)
}

fn decode_packets(
    packets: impl IntoIterator<Item = Vec<u8>>,
    sample_rate: u32,
    channels: u8,
    num_samples: u64,
) -> CliResult<Vec<f32>> {
    let ch = channels as usize;
    let mut dec = Decoder::new(sample_rate, channels)?;
    let mut out = Vec::new();
    for p in packets {
        out.extend(dec.decode_frame(&p)?);
    }
    // Кодек-задержка FRAME_N, затем обрезка до исходной длины.
    let skip = (FRAME_N * ch).min(out.len());
    let mut trimmed = out.split_off(skip);
    trimmed.truncate(num_samples as usize * ch);
    Ok(trimmed)
}

fn stream_config(sample_rate: u32, channels: u16, bitrate_kbps: u32) -> CliResult<Config> {
    if channels == 0 || channels > 2 {
        return Err("поддерживаются 1 или 2 канала".into());
    }
    Ok(Config {
        sample_rate,
        channels: channels as u8,
        bitrate_bps: bitrate_kbps.saturating_mul(1000),
    })
}

// ---------- Команды ----------

fn encode(input: &std::path::Path, output: &std::path::Path, bitrate: u32) -> CliResult<()> {
    let (pcm, rate, ch) = read_wav(input)?;
    let cfg = stream_config(rate, ch, bitrate)?;
    let num_samples = (pcm.len() / ch as usize) as u64;
    let packets = encode_packets(cfg, &pcm)?;

    let mut w = BufWriter::new(File::create(output)?);
    let header = container::Header {
        channels: ch as u8,
        sample_rate: rate,
        num_samples,
    };
    w.write_all(&header.to_bytes())?;
    let mut payload = 0u64;
    for p in &packets {
        let len = u16::try_from(p.len()).map_err(|_| "пакет больше 64 КиБ")?;
        w.write_all(&len.to_le_bytes())?;
        w.write_all(p)?;
        payload += p.len() as u64;
    }
    w.flush()?;
    let secs = num_samples as f64 / f64::from(rate);
    println!(
        "encoded: {} кадров, payload {:.1} КиБ, {:.1} kbps (цель {bitrate})",
        packets.len(),
        payload as f64 / 1024.0,
        payload as f64 * 8.0 / secs / 1000.0
    );
    Ok(())
}

fn decode(input: &std::path::Path, output: &std::path::Path) -> CliResult<()> {
    let mut bytes = Vec::new();
    File::open(input)?.read_to_end(&mut bytes)?;
    let header = container::Header::parse(&bytes)?;
    let mut packets = Vec::new();
    let mut pos = container::HEADER_LEN;
    while pos + 2 <= bytes.len() {
        let len = u16::from_le_bytes([bytes[pos], bytes[pos + 1]]) as usize;
        pos += 2;
        if pos + len > bytes.len() {
            return Err(frc_a_core::Error::Truncated.into());
        }
        packets.push(bytes[pos..pos + len].to_vec());
        pos += len;
    }
    let pcm = decode_packets(
        packets,
        header.sample_rate,
        header.channels,
        header.num_samples,
    )?;
    write_wav_i16(output, &pcm, header.sample_rate, u16::from(header.channels))?;
    println!(
        "decoded: {} сэмплов/канал @ {} Гц, {} ch",
        header.num_samples, header.sample_rate, header.channels
    );
    Ok(())
}

fn roundtrip(
    input: &std::path::Path,
    bitrate: u32,
    output: Option<&std::path::Path>,
) -> CliResult<()> {
    let (pcm, rate, ch) = read_wav(input)?;
    let cfg = stream_config(rate, ch, bitrate)?;
    let num_samples = (pcm.len() / ch as usize) as u64;
    let packets = encode_packets(cfg, &pcm)?;
    let payload: u64 = packets.iter().map(|p| p.len() as u64).sum();
    let decoded = decode_packets(packets.clone(), rate, ch as u8, num_samples)?;

    let n = pcm.len().min(decoded.len());
    let mut sig = 0f64;
    let mut err = 0f64;
    for (&a, &b) in pcm[..n].iter().zip(&decoded[..n]) {
        sig += f64::from(a) * f64::from(a);
        let e = f64::from(a) - f64::from(b);
        err += e * e;
    }
    let snr = if err == 0.0 {
        f64::INFINITY
    } else {
        10.0 * (sig / err).log10()
    };
    let secs = num_samples as f64 / f64::from(rate);

    let transients = packets
        .iter()
        .filter(|p| p.first().is_some_and(|b| b & 1 != 0))
        .count();
    println!("вход:      {secs:.2} с, {rate} Гц, {ch} ch");
    println!(
        "битрейт:   цель {bitrate} kbps, факт {:.1} kbps (payload, {} кадров)",
        payload as f64 * 8.0 / secs / 1000.0,
        packets.len()
    );
    println!("SNR:       {snr:.1} дБ");
    println!("транзиенты: {transients} кадров");
    if let Some(path) = output {
        write_wav_i16(path, &decoded, rate, ch)?;
        println!("декод:     записан в {}", path.display());
    }
    Ok(())
}

fn generate(
    output: &std::path::Path,
    seconds: f32,
    sample_rate: u32,
    channels: u16,
    signal: Signal,
) -> CliResult<()> {
    if channels == 0 || channels > 2 {
        return Err("поддерживаются 1 или 2 канала".into());
    }
    let total = (seconds * sample_rate as f32) as usize;
    let ch = channels as usize;
    let mut out = Vec::with_capacity(total * ch);
    let mut noise_state = 0x1357_9BDFu32;
    let mut lp = [0f32; 2];
    let mut sweep_phase = 0f64;
    for j in 0..total {
        let t = j as f32 / sample_rate as f32;
        for (c, lp_c) in lp.iter_mut().enumerate().take(ch) {
            let s = match signal {
                Signal::Sine => 0.5 * (2.0 * core::f32::consts::PI * 440.0 * t).sin(),
                Signal::Noise => 0.3 * xorshift(&mut noise_state),
                Signal::Sweep => {
                    if c == 0 {
                        let f = 30.0 * (20_000.0f64 / 30.0).powf(f64::from(t) / f64::from(seconds));
                        sweep_phase += 2.0 * core::f64::consts::PI * f / f64::from(sample_rate);
                    }
                    0.5 * (sweep_phase as f32).sin()
                }
                Signal::Mix => {
                    let det = 1.0 + 0.001 * c as f32;
                    let trem = 0.7 + 0.3 * (2.0 * core::f32::consts::PI * 3.0 * t).sin();
                    let chord = 0.30 * (2.0 * core::f32::consts::PI * 220.0 * det * t).sin()
                        + 0.22 * (2.0 * core::f32::consts::PI * 277.18 * det * t).sin()
                        + 0.18 * (2.0 * core::f32::consts::PI * 329.63 * det * t + c as f32).sin();
                    *lp_c = 0.85 * *lp_c + 0.15 * xorshift(&mut noise_state);
                    let click_phase = j % (sample_rate as usize / 2);
                    let click = if click_phase < 240 {
                        0.35 * xorshift(&mut noise_state) * (-(click_phase as f32) / 40.0).exp()
                    } else {
                        0.0
                    };
                    chord * trem + 0.10 * *lp_c + click
                }
            };
            out.push(s.clamp(-0.95, 0.95));
        }
    }
    write_wav_i16(output, &out, sample_rate, channels)?;
    println!(
        "generated: {} ({seconds} с, {sample_rate} Гц, {channels} ch)",
        output.display()
    );
    Ok(())
}

fn xorshift(state: &mut u32) -> f32 {
    *state ^= *state << 13;
    *state ^= *state >> 17;
    *state ^= *state << 5;
    (*state as f32 / 2f32.powi(31)) - 1.0
}
