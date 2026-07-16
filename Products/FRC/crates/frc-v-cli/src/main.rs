//! CLI видеокодека FRC-V. Подкоманды: encode / decode / info / psnr.
//! Аргументы разбираются вручную — workspace остаётся без внешних зависимостей.
//!
//! Контейнеры: нативный `.frv` (по умолчанию) и `.ivf` (совместимость с
//! инструментами VP8/AV1). При кодировании формат выбирается расширением
//! выхода, при чтении — сигнатурой файла.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::process::ExitCode;
use std::time::Instant;

use frc_v::container::{FRC_V_MAGIC, FrcVHeader, FrcVReader, FrcVWriter};
use frc_v::ivf::{IvfHeader, IvfReader, IvfWriter};
use frc_v::metrics::PsnrAccum;
use frc_v::y4m::{VideoParams, Y4mReader, Y4mWriter};
use frc_v::{Decoder, Encoder, EncoderConfig};

const USAGE: &str = "\
FRC-V — Flora Relativistic Codec (video, битстрим FRV1 v1)

Использование:
  frc-v encode -i <in.y4m> -o <out.frv|out.ivf> [--qp <0..63>] [--speed <0..2>] [--bitrate <kbps>] [--keyint <N>] [--ssim-tune] [--no-filter] [--frames <N>]
  frc-v decode -i <in.frv|in.ivf> -o <out.y4m>
  frc-v info   -i <in.frv|in.ivf>
  frc-v psnr   --ref <ref.y4m> --dist <dist.y4m>

Опции encode:
  --qp <N>      параметр квантования, 0 (почти без потерь) .. 63 (максимальное сжатие); по умолчанию 32
  --speed <N>   пресет скорости: 0 — полный RDO (по умолчанию), 1 — сокращённый, 2 — быстрый;
                битстрим и декодер от пресета не зависят
  --bitrate <N> целевой средний битрейт (кбит/с); включает однопроходный rate control (смещение qp)
  --keyint <N>  интервал ключевых кадров (1 = все intra); по умолчанию 60
  --ssim-tune   психовизуальная настройка RDO (смешивание SSE с SSIM-прокси)
  --no-filter   отключить деблокинг-фильтр
  --frames <N>  закодировать не более N кадров

Контейнер выхода: .ivf → IVF, иначе нативный FRC-V (magic 8F 46 52 56).
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first() else {
        eprint!("{USAGE}");
        return ExitCode::from(1);
    };
    let rest = &args[1..];
    let result = match cmd.as_str() {
        "encode" => cmd_encode(rest),
        "decode" => cmd_decode(rest),
        "info" => cmd_info(rest),
        "psnr" => cmd_psnr(rest),
        "--help" | "-h" | "help" => {
            print!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        other => Err(format!("неизвестная команда `{other}`\n\n{USAGE}")),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("frc-v: {e}");
            ExitCode::from(2)
        }
    }
}

/// Значение опции `name` из списка аргументов.
fn opt<'a>(args: &'a [String], name: &str) -> Result<Option<&'a str>, String> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == name {
            return match it.next() {
                Some(v) => Ok(Some(v)),
                None => Err(format!("опция {name} требует значение")),
            };
        }
    }
    Ok(None)
}

fn req<'a>(args: &'a [String], name: &str) -> Result<&'a str, String> {
    opt(args, name)?.ok_or_else(|| format!("не задана обязательная опция {name}"))
}

fn flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn open_in(path: &str) -> Result<BufReader<File>, String> {
    File::open(path)
        .map(BufReader::new)
        .map_err(|e| format!("не открыть {path}: {e}"))
}

fn open_out(path: &str) -> Result<BufWriter<File>, String> {
    File::create(path)
        .map(BufWriter::new)
        .map_err(|e| format!("не создать {path}: {e}"))
}

/// Приёмник пакетов: нативный FRC-V или IVF.
enum PacketSink<W: Write + Seek> {
    FrcV(FrcVWriter<W>),
    Ivf(IvfWriter<W>),
}

impl<W: Write + Seek> PacketSink<W> {
    fn create(out: W, use_ivf: bool, p: VideoParams) -> Result<Self, String> {
        if use_ivf {
            let header = IvfHeader {
                fourcc: frc_v::FOURCC,
                width: p.width as u16,
                height: p.height as u16,
                timebase_den: p.fps_num,
                timebase_num: p.fps_den,
                frame_count: 0, // патчится в finalize()
            };
            Ok(PacketSink::Ivf(
                IvfWriter::new(out, header).map_err(|e| e.to_string())?,
            ))
        } else {
            let header = FrcVHeader {
                width: p.width as u16,
                height: p.height as u16,
                fps_num: p.fps_num,
                fps_den: p.fps_den,
                frame_count: 0,
            };
            Ok(PacketSink::FrcV(
                FrcVWriter::new(out, header).map_err(|e| e.to_string())?,
            ))
        }
    }

    fn write_frame(&mut self, pts: u64, payload: &[u8]) -> Result<(), String> {
        match self {
            PacketSink::FrcV(w) => w.write_frame(pts, payload),
            PacketSink::Ivf(w) => w.write_frame(pts, payload),
        }
        .map_err(|e| e.to_string())
    }

    fn finalize(self) -> Result<(), String> {
        match self {
            PacketSink::FrcV(w) => w.finalize().map(|_| ()),
            PacketSink::Ivf(w) => w.finalize().map(|_| ()),
        }
        .map_err(|e| e.to_string())
    }
}

/// Источник пакетов с параметрами потока.
enum PacketSource<R: Read> {
    FrcV(FrcVReader<R>),
    Ivf(IvfReader<R>),
}

impl<R: Read> PacketSource<R> {
    fn params(&self) -> VideoParams {
        match self {
            PacketSource::FrcV(r) => VideoParams {
                width: usize::from(r.header.width),
                height: usize::from(r.header.height),
                fps_num: r.header.fps_num.max(1),
                fps_den: r.header.fps_den.max(1),
            },
            PacketSource::Ivf(r) => VideoParams {
                width: usize::from(r.header.width),
                height: usize::from(r.header.height),
                fps_num: r.header.timebase_den.max(1),
                fps_den: r.header.timebase_num.max(1),
            },
        }
    }

    fn declared_frames(&self) -> u32 {
        match self {
            PacketSource::FrcV(r) => r.header.frame_count,
            PacketSource::Ivf(r) => r.header.frame_count,
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            PacketSource::FrcV(_) => "FRC-V",
            PacketSource::Ivf(_) => "IVF",
        }
    }

    fn read_frame(&mut self) -> std::io::Result<Option<(u64, Vec<u8>)>> {
        match self {
            PacketSource::FrcV(r) => r.read_frame(),
            PacketSource::Ivf(r) => r.read_frame(),
        }
    }
}

/// Открывает контейнер по сигнатуре (FRC-V magic или DKIF).
fn open_source(path: &str) -> Result<PacketSource<BufReader<File>>, String> {
    let mut reader = open_in(path)?;
    let mut magic = [0u8; 4];
    reader
        .read_exact(&mut magic)
        .map_err(|e| format!("{path}: {e}"))?;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|e| format!("{path}: {e}"))?;
    if magic == FRC_V_MAGIC {
        Ok(PacketSource::FrcV(
            FrcVReader::new(reader).map_err(|e| format!("{path}: {e}"))?,
        ))
    } else if &magic == b"DKIF" {
        let r = IvfReader::new(reader).map_err(|e| format!("{path}: {e}"))?;
        if r.header.fourcc != frc_v::FOURCC {
            return Err(format!("{path}: FourCC не FRV1"));
        }
        Ok(PacketSource::Ivf(r))
    } else {
        Err(format!("{path}: не FRC-V и не IVF файл"))
    }
}

fn cmd_encode(args: &[String]) -> Result<(), String> {
    let input = req(args, "-i")?;
    let output = req(args, "-o")?;
    let qp: u8 = opt(args, "--qp")?
        .unwrap_or("32")
        .parse()
        .map_err(|_| "неверный --qp".to_string())?;
    let speed: u8 = opt(args, "--speed")?
        .unwrap_or("0")
        .parse()
        .map_err(|_| "неверный --speed".to_string())?;
    let keyint: u32 = opt(args, "--keyint")?
        .unwrap_or("60")
        .parse()
        .map_err(|_| "неверный --keyint".to_string())?;
    let target_kbps: Option<u32> = opt(args, "--bitrate")?
        .map(str::parse)
        .transpose()
        .map_err(|_| "неверный --bitrate".to_string())?;
    let ssim_tune = flag(args, "--ssim-tune");
    let max_frames: u64 = opt(args, "--frames")?
        .map(str::parse)
        .transpose()
        .map_err(|_| "неверный --frames")?
        .unwrap_or(u64::MAX);
    let loop_filter = !flag(args, "--no-filter");

    let mut reader = Y4mReader::new(open_in(input)?).map_err(|e| format!("{input}: {e}"))?;
    let p = reader.params;
    let cfg = EncoderConfig {
        width: p.width as u32,
        height: p.height as u32,
        qp,
        loop_filter,
        keyint,
        target_kbps,
        fps_num: p.fps_num,
        fps_den: p.fps_den,
        ssim_tune,
        speed,
    };
    let mut encoder = Encoder::new(cfg).map_err(|e| e.to_string())?;

    let use_ivf = output.to_ascii_lowercase().ends_with(".ivf");
    let mut sink = PacketSink::create(open_out(output)?, use_ivf, p)?;

    let mut psnr = PsnrAccum::default();
    let mut total_bytes = 0u64;
    let mut n = 0u64;
    let mut keyframes = 0u64;
    let started = Instant::now();
    while n < max_frames {
        let Some(frame) = reader.read_frame().map_err(|e| format!("{input}: {e}"))? else {
            break;
        };
        let packet = encoder.encode_frame(&frame).map_err(|e| e.to_string())?;
        total_bytes += packet.data.len() as u64;
        keyframes += u64::from(packet.keyframe);
        sink.write_frame(n, &packet.data)?;
        psnr.add(&frame, encoder.last_recon());
        n += 1;
    }
    if n == 0 {
        return Err("во входном файле нет кадров".into());
    }
    sink.finalize()?;
    let elapsed = started.elapsed().as_secs_f64();
    let q = psnr.result();
    let pixels = (p.width * p.height) as u64 * n;
    let bpp = total_bytes as f64 * 8.0 / pixels as f64;
    let kbps =
        total_bytes as f64 * 8.0 / 1000.0 * f64::from(p.fps_num) / f64::from(p.fps_den) / n as f64;
    println!(
        "encoded {n} frames ({keyframes} key) {}x{} qp={qp} speed={speed} keyint={keyint}{}: {total_bytes} bytes \
         ({bpp:.4} bpp, {kbps:.0} kbps), PSNR Y {:.2} dB / Cb {:.2} / Cr {:.2} / overall {:.2}, {:.2} fps",
        p.width,
        p.height,
        if let Some(kbps) = target_kbps {
            format!(" bitrate={kbps}kbps")
        } else {
            String::new()
        },
        q.y,
        q.cb,
        q.cr,
        q.overall,
        n as f64 / elapsed
    );
    Ok(())
}

fn cmd_decode(args: &[String]) -> Result<(), String> {
    let input = req(args, "-i")?;
    let output = req(args, "-o")?;
    let mut source = open_source(input)?;
    let params = source.params();
    let mut writer: Option<Y4mWriter<_>> = None;
    let mut decoder = Decoder::new();
    let mut n = 0u64;
    let started = Instant::now();
    while let Some((_pts, payload)) = source.read_frame().map_err(|e| format!("{input}: {e}"))? {
        let frame = decoder.decode_frame(&payload).map_err(|e| e.to_string())?;
        if writer.is_none() {
            let p = VideoParams {
                width: frame.width(),
                height: frame.height(),
                ..params
            };
            writer = Some(Y4mWriter::new(open_out(output)?, p).map_err(|e| e.to_string())?);
        }
        writer
            .as_mut()
            .expect("created above")
            .write_frame(&frame)
            .map_err(|e| e.to_string())?;
        n += 1;
    }
    let elapsed = started.elapsed().as_secs_f64();
    println!("decoded {n} frames, {:.2} fps", n as f64 / elapsed);
    Ok(())
}

fn cmd_info(args: &[String]) -> Result<(), String> {
    let input = req(args, "-i")?;
    let mut source = open_source(input)?;
    let p = source.params();
    println!(
        "{}: {}x{}, fps {}/{}, заявлено кадров: {}",
        source.kind(),
        p.width,
        p.height,
        p.fps_num,
        p.fps_den,
        source.declared_frames()
    );
    let mut n = 0u64;
    let mut bytes = 0u64;
    let mut keyframes = 0u64;
    let mut min = usize::MAX;
    let mut max = 0usize;
    while let Some((_, payload)) = source.read_frame().map_err(|e| format!("{input}: {e}"))? {
        n += 1;
        bytes += payload.len() as u64;
        // Бит 0 флагов заголовка кадра — keyframe.
        keyframes += u64::from(payload.len() > 1 && payload[1] & 1 != 0);
        min = min.min(payload.len());
        max = max.max(payload.len());
    }
    match bytes.checked_div(n) {
        Some(avg) => println!(
            "кадров: {n} (ключевых {keyframes}), всего {bytes} байт, средний {avg} байт, min {min}, max {max}"
        ),
        None => println!("кадров: 0"),
    }
    Ok(())
}

fn cmd_psnr(args: &[String]) -> Result<(), String> {
    let ref_path = req(args, "--ref")?;
    let dist_path = req(args, "--dist")?;
    let mut ref_reader =
        Y4mReader::new(open_in(ref_path)?).map_err(|e| format!("{ref_path}: {e}"))?;
    let mut dist_reader =
        Y4mReader::new(open_in(dist_path)?).map_err(|e| format!("{dist_path}: {e}"))?;
    if ref_reader.params.width != dist_reader.params.width
        || ref_reader.params.height != dist_reader.params.height
    {
        return Err("размеры последовательностей не совпадают".into());
    }
    let mut acc = PsnrAccum::default();
    let mut n = 0u64;
    loop {
        let a = ref_reader
            .read_frame()
            .map_err(|e| format!("{ref_path}: {e}"))?;
        let b = dist_reader
            .read_frame()
            .map_err(|e| format!("{dist_path}: {e}"))?;
        match (a, b) {
            (Some(a), Some(b)) => {
                acc.add(&a, &b);
                n += 1;
            }
            (None, None) => break,
            _ => return Err("разное число кадров".into()),
        }
    }
    if n == 0 {
        return Err("нет кадров".into());
    }
    let q = acc.result();
    println!(
        "{n} frames: PSNR Y {:.3} dB, Cb {:.3}, Cr {:.3}, overall {:.3}",
        q.y, q.cb, q.cr, q.overall
    );
    Ok(())
}
