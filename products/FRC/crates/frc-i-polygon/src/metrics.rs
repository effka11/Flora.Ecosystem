//! Единые метрики арены: PSNR (RGB и Y BT.709) и SSIM считаются одним и тем
//! же кодом этого crate по PNG-парам для всех участников; SSIMULACRA2 и
//! butteraugli pnorm — внешними бинарями libjxl (опционально, при
//! недоступности деградируют в `None`).
//!
//! PSNR-Y на BT.709-люме — как у исторической арены `tools/frc-i-compete`.
//! SSIM — окна 8×8 с шагом 4, стандартные константы; в отчёт уходит
//! линеаризованная форма −10·log10(1−SSIM), пригодная для BD-интегрирования.

use std::path::Path;
use std::process::Command;

/// Пиксели изображения: RGB либо RGBA, interleaved.
pub struct Pixels {
    pub width: u32,
    pub height: u32,
    pub channels: u8,
    pub data: Vec<u8>,
}

impl Pixels {
    /// Загружает PNG (любой поддерживаемый `image` формат) и приводит
    /// к RGB/RGBA без потери альфы.
    pub fn load(path: &Path) -> Result<Pixels, String> {
        let img = image::ImageReader::open(path)
            .map_err(|e| format!("{}: {e}", path.display()))?
            .decode()
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let has_alpha = img.color().has_alpha();
        if has_alpha {
            let rgba = img.to_rgba8();
            let (width, height) = rgba.dimensions();
            Ok(Pixels {
                width,
                height,
                channels: 4,
                data: rgba.into_raw(),
            })
        } else {
            let rgb = img.to_rgb8();
            let (width, height) = rgb.dimensions();
            Ok(Pixels {
                width,
                height,
                channels: 3,
                data: rgb.into_raw(),
            })
        }
    }

    fn luma709(&self) -> Vec<f64> {
        let ch = usize::from(self.channels);
        self.data
            .chunks(ch)
            .map(|p| 0.2126 * f64::from(p[0]) + 0.7152 * f64::from(p[1]) + 0.0722 * f64::from(p[2]))
            .collect()
    }
}

/// Кап PSNR как у x264/ffmpeg (JSON не умеет inf, BD по inf не считается).
fn cap(v: f64) -> f64 {
    if v.is_finite() { v } else { 99.99 }
}

fn psnr_from_mse(mse: f64) -> f64 {
    if mse <= 0.0 {
        return 99.99;
    }
    cap(10.0 * (255.0 * 255.0 / mse).log10())
}

/// Метрики одной пары (эталон, декод).
#[derive(Debug, Clone, Copy)]
pub struct PairQuality {
    /// PSNR по каналам RGB (по RGBA — включая альфу), dB.
    pub psnr_rgb: f64,
    /// PSNR по BT.709-люме, dB.
    pub psnr_y: f64,
    /// SSIM (8×8, шаг 4) на люме: сырое значение и −10·log10(1−ssim).
    pub ssim: f64,
    pub ssim_db: f64,
    /// PSNR альфа-канала (только если оба изображения RGBA).
    pub alpha_psnr: Option<f64>,
}

/// PSNR/SSIM между эталоном и декодом.
pub fn quality(reference: &Pixels, distorted: &Pixels) -> Result<PairQuality, String> {
    if reference.width != distorted.width
        || reference.height != distorted.height
        || reference.channels != distorted.channels
    {
        return Err(format!(
            "геометрия не совпадает: {}x{}ch{} против {}x{}ch{}",
            distorted.width,
            distorted.height,
            distorted.channels,
            reference.width,
            reference.height,
            reference.channels,
        ));
    }
    let n = reference.data.len() as f64;
    let sse: f64 = reference
        .data
        .iter()
        .zip(&distorted.data)
        .map(|(&a, &b)| {
            let d = f64::from(a) - f64::from(b);
            d * d
        })
        .sum();
    let psnr_rgb = psnr_from_mse(sse / n);

    let (la, lb) = (reference.luma709(), distorted.luma709());
    let sse_y: f64 = la
        .iter()
        .zip(&lb)
        .map(|(a, b)| {
            let d = a - b;
            d * d
        })
        .sum();
    let psnr_y = psnr_from_mse(sse_y / (la.len() as f64));

    let ssim = ssim_luma(
        &la,
        &lb,
        reference.width as usize,
        reference.height as usize,
    );
    let ssim_db = -10.0 * (1.0 - ssim.min(0.999_999_999)).log10();

    let alpha_psnr = if reference.channels == 4 {
        let sse_a: f64 = reference
            .data
            .chunks(4)
            .zip(distorted.data.chunks(4))
            .map(|(a, b)| {
                let d = f64::from(a[3]) - f64::from(b[3]);
                d * d
            })
            .sum();
        Some(psnr_from_mse(sse_a / (la.len() as f64)))
    } else {
        None
    };

    Ok(PairQuality {
        psnr_rgb,
        psnr_y,
        ssim,
        ssim_db,
        alpha_psnr,
    })
}

/// SSIM на люме: непересекающаяся решётка окон 8×8 с шагом 4 (как
/// `frc_v::metrics`, которым пользовался видео-полигон), стандартные
/// константы K1=0.01, K2=0.03.
fn ssim_luma(a: &[f64], b: &[f64], w: usize, h: usize) -> f64 {
    const K1: f64 = 0.01;
    const K2: f64 = 0.03;
    let c1 = (K1 * 255.0) * (K1 * 255.0);
    let c2 = (K2 * 255.0) * (K2 * 255.0);
    let (mut sum, mut cnt) = (0.0f64, 0u64);
    let mut y = 0;
    while y + 8 <= h {
        let mut x = 0;
        while x + 8 <= w {
            let (mut sa, mut sb) = (0.0, 0.0);
            let (mut saa, mut sbb, mut sab) = (0.0, 0.0, 0.0);
            for dy in 0..8 {
                for dx in 0..8 {
                    let i = (y + dy) * w + x + dx;
                    let (va, vb) = (a[i], b[i]);
                    sa += va;
                    sb += vb;
                    saa += va * va;
                    sbb += vb * vb;
                    sab += va * vb;
                }
            }
            let n = 64.0;
            let (ma, mb) = (sa / n, sb / n);
            let va = saa / n - ma * ma;
            let vb = sbb / n - mb * mb;
            let cov = sab / n - ma * mb;
            let num = (2.0 * ma * mb + c1) * (2.0 * cov + c2);
            let den = (ma * ma + mb * mb + c1) * (va + vb + c2);
            sum += num / den;
            cnt += 1;
            x += 4;
        }
        y += 4;
    }
    if cnt == 0 { 1.0 } else { sum / cnt as f64 }
}

// ---------------------------------------------------------------------------
// Внешние метрики libjxl (опционально)
// ---------------------------------------------------------------------------

/// Проверка доступности бинаря (запуск без аргументов: важен факт spawn,
/// а не код выхода).
fn tool_available(tool: &str, probe_args: &[&str]) -> bool {
    Command::new(tool)
        .args(probe_args)
        .output()
        .map(|_| true)
        .unwrap_or(false)
}

/// Доступность `ssimulacra2` (libjxl tools).
pub fn ssimulacra2_available(tool: &str) -> bool {
    tool_available(tool, &["--help"])
}

/// Доступность `butteraugli_main` (libjxl tools).
pub fn butteraugli_available(tool: &str) -> bool {
    tool_available(tool, &["--help"])
}

/// Последнее числовое значение в тексте (вывод метрик libjxl — строки
/// вида `...: 83.123456`; берём последний float-токен).
fn last_float(text: &str) -> Option<f64> {
    text.split(|c: char| {
        !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+' || c == 'e' || c == 'E')
    })
    .filter(|t| t.contains(|c: char| c.is_ascii_digit()))
    .filter_map(|t| t.parse::<f64>().ok())
    .next_back()
}

/// SSIMULACRA2 (выше = лучше): `ssimulacra2 ref.png dist.png`.
pub fn ssimulacra2(tool: &str, reference: &Path, distorted: &Path) -> Result<f64, String> {
    let out = Command::new(tool)
        .arg(reference)
        .arg(distorted)
        .output()
        .map_err(|e| format!("ssimulacra2: запуск: {e}"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if !out.status.success() {
        return Err(format!(
            "ssimulacra2: код {:?}: {}",
            out.status.code(),
            tail(&text)
        ));
    }
    last_float(&text).ok_or_else(|| format!("ssimulacra2: нет числа в выводе: {}", tail(&text)))
}

/// butteraugli pnorm (ниже = лучше): `butteraugli_main ref.png dist.png`.
/// Предпочитаем строку pnorm/3-norm, иначе — последнее число вывода.
pub fn butteraugli(tool: &str, reference: &Path, distorted: &Path) -> Result<f64, String> {
    let out = Command::new(tool)
        .arg(reference)
        .arg(distorted)
        .output()
        .map_err(|e| format!("butteraugli: запуск: {e}"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if !out.status.success() {
        return Err(format!(
            "butteraugli: код {:?}: {}",
            out.status.code(),
            tail(&text)
        ));
    }
    for line in text.lines() {
        let low = line.to_lowercase();
        if (low.contains("pnorm") || low.contains("3-norm"))
            && let Some(v) = last_float(line)
        {
            return Ok(v);
        }
    }
    last_float(&text).ok_or_else(|| format!("butteraugli: нет числа в выводе: {}", tail(&text)))
}

fn tail(text: &str) -> String {
    let t = text.trim();
    t.chars()
        .rev()
        .take(300)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(w: u32, h: u32, ch: u8) -> Pixels {
        let mut data = vec![0u8; (w * h) as usize * usize::from(ch)];
        for (i, p) in data.iter_mut().enumerate() {
            // Диапазон 0..=245: сдвиг +10 в тестах не упирается в насыщение.
            *p = ((i * 7 + 13) % 246) as u8;
        }
        Pixels {
            width: w,
            height: h,
            channels: ch,
            data,
        }
    }

    #[test]
    fn identical_images_max_quality() {
        let a = gradient(64, 64, 3);
        let b = gradient(64, 64, 3);
        let q = quality(&a, &b).unwrap();
        assert_eq!(q.psnr_rgb, 99.99);
        assert_eq!(q.psnr_y, 99.99);
        assert!((q.ssim - 1.0).abs() < 1e-9, "ssim = {}", q.ssim);
        assert!(q.alpha_psnr.is_none());
    }

    #[test]
    fn constant_shift_drops_psnr() {
        let a = gradient(64, 64, 3);
        let mut b = gradient(64, 64, 3);
        for p in &mut b.data {
            *p = p.saturating_add(10);
        }
        let q = quality(&a, &b).unwrap();
        // Сдвиг ровно на 10 (без клиппинга на этом диапазоне): MSE = 100.
        assert!((q.psnr_rgb - 28.13).abs() < 0.05, "psnr = {}", q.psnr_rgb);
    }

    #[test]
    fn rgba_alpha_psnr() {
        let a = gradient(32, 32, 4);
        let b = gradient(32, 32, 4);
        let q = quality(&a, &b).unwrap();
        assert_eq!(q.alpha_psnr, Some(99.99));
    }

    #[test]
    fn last_float_parses() {
        assert_eq!(last_float("83.123456"), Some(83.123456));
        assert_eq!(last_float("score: 12.5\n"), Some(12.5));
        assert_eq!(last_float("no numbers"), None);
    }
}
