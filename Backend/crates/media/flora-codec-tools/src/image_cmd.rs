//! Субкоманды фото-кодека FRC-I: encode / decode / info / bench.

use clap::Subcommand;
use frc_i::{DecodedImage, EncodeMode, ImageView, PixelFormat, decode, encode, read_info};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder, ImageReader};
use std::error::Error;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::Instant;

type CmdResult = Result<(), Box<dyn Error>>;

#[derive(Subcommand)]
pub enum ImageCommand {
    /// Закодировать PNG/JPEG в .fri
    Encode {
        input: PathBuf,
        output: PathBuf,
        /// Качество lossy-режима 1..=100 (по умолчанию 75)
        #[arg(long, conflicts_with = "lossless")]
        quality: Option<u8>,
        /// Кодировать без потерь
        #[arg(long)]
        lossless: bool,
    },
    /// Декодировать .fri в PNG
    Decode { input: PathBuf, output: PathBuf },
    /// Показать заголовок .fri
    Info { input: PathBuf },
    /// Сравнить FRC-I с PNG (lossless) и JPEG (lossy) на корпусе изображений
    Bench {
        /// Каталог с PNG/JPEG; без него — синтетический корпус
        #[arg(long)]
        dir: Option<PathBuf>,
        /// Качество lossy-сравнения
        #[arg(long, default_value_t = 75)]
        quality: u8,
    },
}

pub fn run(cmd: ImageCommand) -> CmdResult {
    match cmd {
        ImageCommand::Encode {
            input,
            output,
            quality,
            lossless,
        } => cmd_encode(&input, &output, quality, lossless),
        ImageCommand::Decode { input, output } => cmd_decode(&input, &output),
        ImageCommand::Info { input } => cmd_info(&input),
        ImageCommand::Bench { dir, quality } => cmd_bench(dir.as_deref(), quality),
    }
}

/// Загруженное в память изображение-источник.
struct SourceImage {
    name: String,
    width: u32,
    height: u32,
    format: PixelFormat,
    data: Vec<u8>,
}

impl SourceImage {
    fn view(&self) -> ImageView<'_> {
        ImageView {
            width: self.width,
            height: self.height,
            format: self.format,
            data: &self.data,
        }
    }

    fn load(path: &Path) -> Result<Self, Box<dyn Error>> {
        let dynamic = ImageReader::open(path)?.decode()?;
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let (width, height) = (dynamic.width(), dynamic.height());
        Ok(if dynamic.color().has_alpha() {
            let rgba = dynamic.to_rgba8();
            Self {
                name,
                width,
                height,
                format: PixelFormat::Rgba8,
                data: rgba.into_raw(),
            }
        } else {
            let rgb = dynamic.to_rgb8();
            Self {
                name,
                width,
                height,
                format: PixelFormat::Rgb8,
                data: rgb.into_raw(),
            }
        })
    }
}

fn cmd_encode(input: &Path, output: &Path, quality: Option<u8>, lossless: bool) -> CmdResult {
    let src = SourceImage::load(input)?;
    let mode = if lossless {
        EncodeMode::Lossless
    } else {
        EncodeMode::Lossy {
            quality: quality.unwrap_or(75),
        }
    };
    let fri = encode(&src.view(), mode)?;
    fs::write(output, &fri)?;
    let raw_len = src.data.len();
    println!(
        "{} -> {} ({} байт, {:.2}% от несжатых пикселей)",
        input.display(),
        output.display(),
        fri.len(),
        100.0 * fri.len() as f64 / raw_len as f64,
    );
    Ok(())
}

fn cmd_decode(input: &Path, output: &Path) -> CmdResult {
    let fri = fs::read(input)?;
    let img = decode(&fri)?;
    let color = match img.format {
        PixelFormat::Rgb8 => ExtendedColorType::Rgb8,
        PixelFormat::Rgba8 => ExtendedColorType::Rgba8,
    };
    image::save_buffer(output, &img.data, img.width, img.height, color)?;
    println!(
        "{} -> {} ({}x{})",
        input.display(),
        output.display(),
        img.width,
        img.height
    );
    Ok(())
}

fn cmd_info(input: &Path) -> CmdResult {
    let fri = fs::read(input)?;
    let info = read_info(&fri)?;
    println!("FRC-I v{}, {}x{}", info.version, info.width, info.height);
    let mode = if info.palette {
        "lossless (палитра)"
    } else if info.identity {
        "lossless (identity RGB)"
    } else if info.lossless {
        "lossless (YCoCg-R)"
    } else {
        "lossy (DCT)"
    };
    println!("режим:      {mode}");
    if let Some(q) = info.quality {
        println!("quality:    {q}");
        println!(
            "chroma:     {}",
            if info.chroma420 { "4:2:0" } else { "4:4:4" }
        );
    }
    println!("альфа:      {}", if info.has_alpha { "да" } else { "нет" });
    println!("размер:     {} байт", fri.len());
    Ok(())
}

// --- bench -----------------------------------------------------------------

fn cmd_bench(dir: Option<&Path>, quality: u8) -> CmdResult {
    let corpus = match dir {
        Some(d) => load_corpus(d)?,
        None => synthetic_corpus(),
    };
    if corpus.is_empty() {
        return Err("корпус пуст: в каталоге нет PNG/JPEG".into());
    }
    println!(
        "Корпус: {} изображений; lossy-качество: {quality}\n",
        corpus.len()
    );
    println!(
        "{:<18} {:>11} {:>11} {:>7} | {:>11} {:>9} {:>11} {:>9}",
        "изображение", "PNG", "FRC-I-ll", "выигр.", "JPEG", "PSNR", "FRC-I-lossy", "PSNR"
    );

    let (mut png_total, mut ll_total, mut jpeg_total, mut lossy_total) = (0u64, 0u64, 0u64, 0u64);
    let (mut enc_ns, mut dec_ns, mut px_total) = (0u128, 0u128, 0u64);
    for src in &corpus {
        let png = encode_png(src)?;
        let fic_ll = encode(&src.view(), EncodeMode::Lossless)?;
        let jpeg = encode_jpeg(src, quality)?;
        let t1 = Instant::now();
        let fic_lossy = encode(&src.view(), EncodeMode::Lossy { quality })?;
        let t2 = Instant::now();
        let fic_decoded = decode(&fic_lossy)?;
        let t3 = Instant::now();
        enc_ns += (t2 - t1).as_nanos();
        dec_ns += (t3 - t2).as_nanos();
        px_total += u64::from(src.width) * u64::from(src.height);

        let jpeg_psnr = psnr_against(src, &decode_jpeg(&jpeg)?);
        let fic_psnr = psnr_against(src, &decoded_pixels(&fic_decoded));

        png_total += png.len() as u64;
        ll_total += fic_ll.len() as u64;
        jpeg_total += jpeg.len() as u64;
        lossy_total += fic_lossy.len() as u64;

        println!(
            "{:<18} {:>11} {:>11} {:>6.1}% | {:>11} {:>8.2} {:>11} {:>8.2}",
            src.name,
            png.len(),
            fic_ll.len(),
            100.0 * (1.0 - fic_ll.len() as f64 / png.len() as f64),
            jpeg.len(),
            jpeg_psnr,
            fic_lossy.len(),
            fic_psnr,
        );
    }
    println!(
        "\nИтого lossless: FRC-I {} vs PNG {} ({:.1}% меньше)",
        ll_total,
        png_total,
        100.0 * (1.0 - ll_total as f64 / png_total as f64),
    );
    println!(
        "Итого lossy q={quality}: FRC-I {} vs JPEG {} ({:.1}% меньше; PSNR — по строкам выше)",
        lossy_total,
        jpeg_total,
        100.0 * (1.0 - lossy_total as f64 / jpeg_total as f64),
    );
    let mp = px_total as f64 / 1e6;
    let threads = std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get);
    println!(
        "Скорость lossy ({threads} потоков): encode {:.1} Мп/с, decode {:.1} Мп/с",
        mp / (enc_ns as f64 / 1e9),
        mp / (dec_ns as f64 / 1e9),
    );
    Ok(())
}

fn load_corpus(dir: &Path) -> Result<Vec<SourceImage>, Box<dyn Error>> {
    let mut out = Vec::new();
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            matches!(
                p.extension()
                    .and_then(|e| e.to_str())
                    .map(str::to_ascii_lowercase)
                    .as_deref(),
                Some("png" | "jpg" | "jpeg")
            )
        })
        .collect();
    entries.sort();
    for path in entries {
        out.push(SourceImage::load(&path)?);
    }
    Ok(out)
}

fn encode_png(src: &SourceImage) -> Result<Vec<u8>, Box<dyn Error>> {
    let mut out = Cursor::new(Vec::new());
    let encoder =
        PngEncoder::new_with_quality(&mut out, CompressionType::Best, FilterType::Adaptive);
    let color = match src.format {
        PixelFormat::Rgb8 => ExtendedColorType::Rgb8,
        PixelFormat::Rgba8 => ExtendedColorType::Rgba8,
    };
    encoder.write_image(&src.data, src.width, src.height, color)?;
    Ok(out.into_inner())
}

fn encode_jpeg(src: &SourceImage, quality: u8) -> Result<Vec<u8>, Box<dyn Error>> {
    // JPEG без альфы: для честности сравниваем только RGB-часть.
    let rgb = rgb_only(src);
    let mut out = Cursor::new(Vec::new());
    let encoder = JpegEncoder::new_with_quality(&mut out, quality);
    encoder.write_image(&rgb, src.width, src.height, ExtendedColorType::Rgb8)?;
    Ok(out.into_inner())
}

fn decode_jpeg(bytes: &[u8]) -> Result<Vec<u8>, Box<dyn Error>> {
    let img = image::load_from_memory(bytes)?;
    Ok(img.to_rgb8().into_raw())
}

fn decoded_pixels(img: &DecodedImage) -> Vec<u8> {
    match img.format {
        PixelFormat::Rgb8 => img.data.clone(),
        PixelFormat::Rgba8 => img
            .data
            .chunks_exact(4)
            .flat_map(|px| [px[0], px[1], px[2]])
            .collect(),
    }
}

fn rgb_only(src: &SourceImage) -> Vec<u8> {
    match src.format {
        PixelFormat::Rgb8 => src.data.clone(),
        PixelFormat::Rgba8 => src
            .data
            .chunks_exact(4)
            .flat_map(|px| [px[0], px[1], px[2]])
            .collect(),
    }
}

/// PSNR по RGB-каналам, dB (бесконечность заменяется на 99).
fn psnr_against(src: &SourceImage, rgb: &[u8]) -> f64 {
    let reference = rgb_only(src);
    debug_assert_eq!(reference.len(), rgb.len());
    let mse: f64 = reference
        .iter()
        .zip(rgb.iter())
        .map(|(&a, &b)| {
            let d = f64::from(a) - f64::from(b);
            d * d
        })
        .sum::<f64>()
        / reference.len() as f64;
    if mse == 0.0 {
        99.0
    } else {
        10.0 * (255.0 * 255.0 / mse).log10()
    }
}

// --- синтетический корпус ----------------------------------------------------

fn xorshift(seed: &mut u64) -> u64 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    *seed
}

/// Value-noise: решётка случайных узлов с билинейной интерполяцией.
fn value_noise(w: usize, h: usize, cell: usize, seed: u64) -> Vec<f64> {
    let gw = w / cell + 2;
    let gh = h / cell + 2;
    let mut s = seed;
    let grid: Vec<f64> = (0..gw * gh)
        .map(|_| (xorshift(&mut s) % 10_000) as f64 / 10_000.0)
        .collect();
    let mut out = Vec::with_capacity(w * h);
    for y in 0..h {
        let gy = y / cell;
        let fy = (y % cell) as f64 / cell as f64;
        for x in 0..w {
            let gx = x / cell;
            let fx = (x % cell) as f64 / cell as f64;
            let a = grid[gy * gw + gx];
            let b = grid[gy * gw + gx + 1];
            let c = grid[(gy + 1) * gw + gx];
            let d = grid[(gy + 1) * gw + gx + 1];
            let top = a + (b - a) * fx;
            let bottom = c + (d - c) * fx;
            out.push(top + (bottom - top) * fy);
        }
    }
    out
}

fn synthetic_corpus() -> Vec<SourceImage> {
    const W: usize = 512;
    const H: usize = 512;
    vec![
        synthetic_photo(W, H),
        synthetic_portrait(W, H),
        synthetic_graphics(W, H),
        synthetic_noise(W, H),
    ]
}

/// «Пейзаж»: многооктавный шум поверх плавных градиентов.
fn synthetic_photo(w: usize, h: usize) -> SourceImage {
    let octaves = [
        (value_noise(w, h, 128, 11), 0.5),
        (value_noise(w, h, 32, 22), 0.3),
        (value_noise(w, h, 8, 33), 0.15),
        (value_noise(w, h, 2, 44), 0.05),
    ];
    let mut data = Vec::with_capacity(w * h * 3);
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let n: f64 = octaves.iter().map(|(o, k)| o[i] * k).sum();
            let sky = 1.0 - y as f64 / h as f64;
            let r = 40.0 + 150.0 * n + 40.0 * sky;
            let g = 60.0 + 130.0 * n + 30.0 * sky;
            let b = 50.0 + 90.0 * n + 90.0 * sky;
            data.extend([clamp_u8(r), clamp_u8(g), clamp_u8(b)]);
        }
    }
    source("photo-512", w, h, data)
}

/// «Портрет»: мягкие радиальные пятна, малошумная кожа-подобная фактура.
fn synthetic_portrait(w: usize, h: usize) -> SourceImage {
    let noise = value_noise(w, h, 16, 55);
    let mut data = Vec::with_capacity(w * h * 3);
    let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.3);
    for y in 0..h {
        for x in 0..w {
            let dx = (x as f64 - cx) / w as f64;
            let dy = (y as f64 - cy) / h as f64;
            let d = (dx * dx + dy * dy).sqrt();
            let face = (1.0 - (d * 3.2).min(1.0)).powf(1.5);
            let n = noise[y * w + x] * 18.0;
            let r = 70.0 + 150.0 * face + n;
            let g = 55.0 + 110.0 * face + n * 0.8;
            let b = 60.0 + 80.0 * face + n * 0.6;
            data.extend([clamp_u8(r), clamp_u8(g), clamp_u8(b)]);
        }
    }
    source("portrait-512", w, h, data)
}

/// «Графика»: плоские заливки, резкие границы, штрихи-«текст».
fn synthetic_graphics(w: usize, h: usize) -> SourceImage {
    let mut data = vec![245u8; w * h * 3];
    let mut set = |x: usize, y: usize, rgb: [u8; 3]| {
        let i = (y * w + x) * 3;
        data[i..i + 3].copy_from_slice(&rgb);
    };
    for y in 0..h {
        for x in 0..w {
            if (60..200).contains(&x) && (40..160).contains(&y) {
                set(x, y, [30, 90, 200]);
            } else if (240..480).contains(&x) && (60..140).contains(&y) {
                set(x, y, [220, 60, 60]);
            } else if x + y > 700 && x + y < 760 {
                set(x, y, [20, 160, 90]);
            }
        }
    }
    // Штрихи, имитирующие строки текста.
    let mut seed = 77u64;
    for line in 0..18 {
        let y0 = 200 + line * 16;
        let mut x = 24usize;
        while x < w - 40 {
            let len = 6 + (xorshift(&mut seed) % 26) as usize;
            for dx in 0..len.min(w - 40 - x) {
                for dy in 0..8 {
                    set(x + dx, y0 + dy, [25, 25, 35]);
                }
            }
            x += len + 5 + (xorshift(&mut seed) % 8) as usize;
        }
    }
    source("graphics-512", w, h, data)
}

/// Чистый шум — худший случай для любого кодека (честность бенчмарка).
fn synthetic_noise(w: usize, h: usize) -> SourceImage {
    let mut seed = 99u64;
    let data: Vec<u8> = (0..w * h * 3)
        .map(|_| (xorshift(&mut seed) & 0xFF) as u8)
        .collect();
    source("noise-512", w, h, data)
}

fn clamp_u8(v: f64) -> u8 {
    v.clamp(0.0, 255.0) as u8
}

fn source(name: &str, w: usize, h: usize, data: Vec<u8>) -> SourceImage {
    SourceImage {
        name: name.to_string(),
        width: w as u32,
        height: h as u32,
        format: PixelFormat::Rgb8,
        data,
    }
}
