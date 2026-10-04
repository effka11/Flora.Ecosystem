//! Единые метрики арены: PSNR/SSIM считаются кодом `frc_v::metrics` по парам
//! y4m (один и тот же код для всех кодеков), VMAF — libvmaf из ffmpeg
//! (опционально, при недоступности деградирует в `None`).

use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::process::Command;

use frc_v::metrics::{PsnrAccum, SsimAccum};
use frc_v::y4m::Y4mReader;

#[derive(Debug, Clone, Copy)]
pub struct PairQuality {
    pub frames: usize,
    pub psnr_y: f64,
    pub psnr_cb: f64,
    pub psnr_cr: f64,
    /// Взвешенный (4·Y + Cb + Cr)/6 по SSE.
    pub psnr_ov: f64,
    pub ssim_y: f64,
    pub ssim_ov: f64,
}

/// PSNR/SSIM между эталоном и декодом (кадры сопоставляются по порядку).
pub fn quality(reference: &Path, distorted: &Path) -> Result<PairQuality, String> {
    let open = |p: &Path| -> Result<Y4mReader<BufReader<File>>, String> {
        Y4mReader::new(BufReader::new(
            File::open(p).map_err(|e| format!("{}: {e}", p.display()))?,
        ))
        .map_err(|e| format!("{}: {e}", p.display()))
    };
    let mut r = open(reference)?;
    let mut d = open(distorted)?;
    if r.params.width != d.params.width || r.params.height != d.params.height {
        return Err(format!(
            "{}: размеры {}x{} не совпадают с эталоном {}x{}",
            distorted.display(),
            d.params.width,
            d.params.height,
            r.params.width,
            r.params.height
        ));
    }
    let mut psnr = PsnrAccum::default();
    let mut ssim = SsimAccum::default();
    let mut n = 0usize;
    loop {
        let a = r.read_frame().map_err(|e| e.to_string())?;
        let b = d.read_frame().map_err(|e| e.to_string())?;
        match (a, b) {
            (Some(a), Some(b)) => {
                psnr.add(&a, &b);
                ssim.add(&a, &b);
                n += 1;
            }
            (None, None) => break,
            _ => {
                return Err(format!(
                    "{}: число кадров не совпадает с эталоном (сравнено {n})",
                    distorted.display()
                ));
            }
        }
    }
    if n == 0 {
        return Err("пустая пара y4m".into());
    }
    let p = psnr.result();
    let s = ssim.result();
    // Лосслесс-декод даёт PSNR = inf; JSON не умеет inf (serde_json пишет
    // null и снимок перестаёт читаться), да и BD-rate по inf не считается.
    // Кап 99.99 dB — как принято у x264/ffmpeg.
    let cap = |v: f64| if v.is_finite() { v } else { 99.99 };
    Ok(PairQuality {
        frames: n,
        psnr_y: cap(p.y),
        psnr_cb: cap(p.cb),
        psnr_cr: cap(p.cr),
        psnr_ov: cap(p.overall),
        ssim_y: s.y,
        ssim_ov: s.overall,
    })
}

/// VMAF через libvmaf (ffmpeg). `work_dir` — каталог для JSON-лога: ffmpeg
/// запускается с этим cwd, а лог пишется по относительному имени (двоеточие
/// абсолютных путей Windows ломает синтаксис фильтра).
pub fn vmaf(
    ffmpeg: &str,
    reference: &Path,
    distorted: &Path,
    work_dir: &Path,
) -> Result<f64, String> {
    let log_name = format!(
        "vmaf-{}.json",
        distorted
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "pair".into())
    );
    // ffmpeg запускается из work_dir (лог-файл фильтра задаётся относительным
    // именем — двоеточие абсолютных путей Windows ломает синтаксис lavfi),
    // поэтому входы должны быть абсолютными.
    let abs = |p: &Path| std::path::absolute(p).map_err(|e| format!("{}: {e}", p.display()));
    let (distorted, reference) = (abs(distorted)?, abs(reference)?);
    let out = Command::new(ffmpeg)
        .current_dir(work_dir)
        .args(["-hide_banner", "-loglevel", "error", "-nostats"])
        .arg("-i")
        .arg(&distorted)
        .arg("-i")
        .arg(&reference)
        .args([
            "-lavfi",
            &format!("libvmaf=log_fmt=json:log_path={log_name}:n_threads=4"),
            "-f",
            "null",
            "-",
        ])
        .output()
        .map_err(|e| format!("vmaf: запуск ffmpeg: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "vmaf: ffmpeg завершился с ошибкой: {}",
            String::from_utf8_lossy(&out.stderr)
                .lines()
                .last()
                .unwrap_or("")
        ));
    }
    let log_path = work_dir.join(&log_name);
    let text = std::fs::read_to_string(&log_path).map_err(|e| format!("vmaf лог: {e}"))?;
    let _ = std::fs::remove_file(&log_path);
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("vmaf json: {e}"))?;
    json.pointer("/pooled_metrics/vmaf/mean")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| "vmaf json: нет pooled_metrics.vmaf.mean".to_string())
}

/// Быстрая проверка наличия libvmaf в сборке ffmpeg.
pub fn vmaf_available(ffmpeg: &str) -> bool {
    Command::new(ffmpeg)
        .args(["-hide_banner", "-filters"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(" libvmaf "))
        .unwrap_or(false)
}
