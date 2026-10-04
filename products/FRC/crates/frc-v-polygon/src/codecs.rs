//! Адаптеры кодеков. Все кодеки — внешние процессы: FRC-V через собственный
//! CLI (`frc-v`), остальные через `ffmpeg`. Условия равные: 1 поток, общий
//! keyint, замер — wall-time всего процесса (запуск + y4m-IO одинаковы для
//! всех), размер — elementary stream без контейнерного оверхеда.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

/// Идентификаторы кодеков арены (порядок = порядок в отчётах).
pub const ALL_CODECS: &[&str] = &["frcv", "x264", "x265", "vp9", "svtav1", "aom"];

/// Параметры кодирования одной точки RD-кривой.
#[derive(Debug, Clone, Copy)]
pub struct EncodeJob<'a> {
    pub input: &'a Path,
    pub output: &'a Path,
    /// Значение качества (qp у FRC-V, crf у остальных).
    pub q: u32,
    pub keyint: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub frames: usize,
}

/// Результат запуска процесса.
pub struct RunOutcome {
    pub wall_secs: f64,
}

/// Окружение арены: пути к бинарям и настройки FRC-V.
pub struct Env {
    pub ffmpeg: String,
    pub frcv_bin: PathBuf,
    pub frcv_speed: u8,
    pub frcv_ssim_tune: bool,
    /// `-tune psnr` у x264/x265/aom, `-tune 0` у vp9.
    pub tune_psnr: bool,
    pub svt_preset: u32,
    pub aom_cpu_used: u32,
}

/// Описание кодека: сетка качеств по умолчанию и команды encode/decode.
pub struct Codec {
    pub id: &'static str,
    pub label: String,
    pub default_points: Vec<u32>,
    /// Расширение файла битстрима.
    pub ext: &'static str,
}

/// Оверхед контейнера IVF/FRV: 32 байта заголовка + 12 на кадр.
fn ivf_overhead(frames: usize) -> u64 {
    32 + 12 * frames as u64
}

impl Codec {
    pub fn by_id(id: &str, env: &Env) -> Option<Codec> {
        let c = match id {
            "frcv" => Codec {
                id: "frcv",
                label: format!(
                    "FRC-V {} (speed {}{})",
                    env!("CARGO_PKG_VERSION"),
                    env.frcv_speed,
                    if env.frcv_ssim_tune {
                        ", ssim-tune"
                    } else {
                        ""
                    }
                ),
                default_points: vec![18, 24, 30, 36, 42, 48],
                ext: "ivf",
            },
            "x264" => Codec {
                id: "x264",
                label: "x264 (medium)".to_string(),
                default_points: vec![16, 21, 26, 31, 36, 41],
                ext: "264",
            },
            "x265" => Codec {
                id: "x265",
                label: "x265 (medium)".to_string(),
                default_points: vec![18, 23, 28, 33, 38, 43],
                ext: "265",
            },
            "vp9" => Codec {
                id: "vp9",
                label: "libvpx-VP9 (good, cpu-used 1)".to_string(),
                default_points: vec![20, 27, 34, 41, 48, 55],
                ext: "ivf",
            },
            "svtav1" => Codec {
                id: "svtav1",
                label: format!("SVT-AV1 (preset {})", env.svt_preset),
                default_points: vec![22, 30, 38, 46, 54, 62],
                ext: "ivf",
            },
            "aom" => Codec {
                id: "aom",
                label: format!("libaom-AV1 (good, cpu-used {})", env.aom_cpu_used),
                default_points: vec![22, 30, 38, 46, 54, 62],
                ext: "ivf",
            },
            _ => return None,
        };
        Some(c)
    }

    /// Полезная нагрузка потока: размер файла минус контейнерный оверхед.
    pub fn payload_bytes(&self, bitstream: &Path, frames: usize) -> std::io::Result<u64> {
        let size = std::fs::metadata(bitstream)?.len();
        Ok(match self.ext {
            "ivf" => size.saturating_sub(ivf_overhead(frames)),
            _ => size,
        })
    }

    /// Команда кодирования.
    fn encode_cmd(&self, env: &Env, job: &EncodeJob) -> Command {
        let g = job.keyint.to_string();
        let q = job.q.to_string();
        match self.id {
            "frcv" => {
                let mut c = Command::new(&env.frcv_bin);
                c.arg("encode")
                    .arg("-i")
                    .arg(job.input)
                    .arg("-o")
                    .arg(job.output)
                    .args(["--qp", &q, "--keyint", &g, "--speed"])
                    .arg(env.frcv_speed.to_string());
                if env.frcv_ssim_tune {
                    c.arg("--ssim-tune");
                }
                c
            }
            "x264" => {
                let mut c = ffmpeg_base(env, job.input);
                c.args(["-c:v", "libx264", "-preset", "medium", "-crf", &q]);
                if env.tune_psnr {
                    c.args(["-tune", "psnr"]);
                }
                c.args(["-g", &g, "-threads", "1", "-f", "h264"])
                    .arg(job.output);
                c
            }
            "x265" => {
                let mut c = ffmpeg_base(env, job.input);
                c.args(["-c:v", "libx265", "-preset", "medium", "-crf", &q]);
                if env.tune_psnr {
                    c.args(["-tune", "psnr"]);
                }
                c.args([
                    "-x265-params",
                    &format!("pools=1:frame-threads=1:keyint={g}:log-level=none"),
                    "-f",
                    "hevc",
                ])
                .arg(job.output);
                c
            }
            "vp9" => {
                let mut c = ffmpeg_base(env, job.input);
                c.args([
                    "-c:v",
                    "libvpx-vp9",
                    "-b:v",
                    "0",
                    "-crf",
                    &q,
                    "-deadline",
                    "good",
                    "-cpu-used",
                    "1",
                ]);
                if env.tune_psnr {
                    c.args(["-tune", "psnr"]);
                }
                c.args(["-g", &g, "-row-mt", "0", "-threads", "1", "-f", "ivf"])
                    .arg(job.output);
                c
            }
            "svtav1" => {
                let mut c = ffmpeg_base(env, job.input);
                c.args([
                    "-c:v",
                    "libsvtav1",
                    "-crf",
                    &q,
                    "-preset",
                    &env.svt_preset.to_string(),
                    "-g",
                    &g,
                    "-svtav1-params",
                    "lp=1",
                    "-f",
                    "ivf",
                ])
                .arg(job.output);
                c
            }
            "aom" => {
                let mut c = ffmpeg_base(env, job.input);
                c.args([
                    "-c:v",
                    "libaom-av1",
                    "-b:v",
                    "0",
                    "-crf",
                    &q,
                    "-cpu-used",
                    &env.aom_cpu_used.to_string(),
                ]);
                if env.tune_psnr {
                    c.args(["-tune", "psnr"]);
                }
                c.args(["-g", &g, "-row-mt", "0", "-threads", "1", "-f", "ivf"])
                    .arg(job.output);
                c
            }
            other => unreachable!("неизвестный кодек {other}"),
        }
    }

    /// Команда декодирования битстрима в y4m.
    fn decode_cmd(&self, env: &Env, bitstream: &Path, output: &Path) -> Command {
        match self.id {
            "frcv" => {
                let mut c = Command::new(&env.frcv_bin);
                c.arg("decode")
                    .arg("-i")
                    .arg(bitstream)
                    .arg("-o")
                    .arg(output);
                c
            }
            _ => {
                let mut c = Command::new(&env.ffmpeg);
                c.args(["-hide_banner", "-loglevel", "error", "-y", "-threads", "1"]);
                // Сырым потокам нужен явный демаксер.
                match self.ext {
                    "264" => {
                        c.args(["-f", "h264"]);
                    }
                    "265" => {
                        c.args(["-f", "hevc"]);
                    }
                    _ => {}
                }
                c.arg("-i")
                    .arg(bitstream)
                    .args(["-pix_fmt", "yuv420p", "-f", "yuv4mpegpipe"])
                    .arg(output);
                c
            }
        }
    }

    pub fn encode(&self, env: &Env, job: &EncodeJob) -> Result<RunOutcome, String> {
        run_timed(self.encode_cmd(env, job), &format!("{} encode", self.id))
    }

    pub fn decode(&self, env: &Env, bitstream: &Path, output: &Path) -> Result<RunOutcome, String> {
        run_timed(
            self.decode_cmd(env, bitstream, output),
            &format!("{} decode", self.id),
        )
    }
}

fn ffmpeg_base(env: &Env, input: &Path) -> Command {
    let mut c = Command::new(&env.ffmpeg);
    c.args(["-hide_banner", "-loglevel", "error", "-y", "-threads", "1"])
        .arg("-i")
        .arg(input);
    c
}

/// Запуск процесса с замером wall-time; stderr показывается только при ошибке.
fn run_timed(mut cmd: Command, what: &str) -> Result<RunOutcome, String> {
    let started = Instant::now();
    let out = cmd
        .output()
        .map_err(|e| format!("{what}: не удалось запустить {:?}: {e}", cmd.get_program()))?;
    let wall_secs = started.elapsed().as_secs_f64();
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: String = stderr
            .lines()
            .rev()
            .take(8)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!("{what}: процесс завершился с ошибкой:\n{tail}"));
    }
    Ok(RunOutcome { wall_secs })
}

/// Обнаружение окружения: ffmpeg-энкодеры и версия.
pub struct Detected {
    pub ffmpeg_version: String,
    pub encoders: Vec<String>,
}

pub fn detect_ffmpeg(ffmpeg: &str) -> Result<Detected, String> {
    let ver = Command::new(ffmpeg)
        .arg("-version")
        .output()
        .map_err(|e| format!("ffmpeg не найден ({ffmpeg}): {e}"))?;
    let version_line = String::from_utf8_lossy(&ver.stdout)
        .lines()
        .next()
        .unwrap_or("ffmpeg (версия неизвестна)")
        .to_string();
    let enc = Command::new(ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .output()
        .map_err(|e| format!("ffmpeg -encoders: {e}"))?;
    let list = String::from_utf8_lossy(&enc.stdout);
    let mut encoders = Vec::new();
    for lib in [
        "libx264",
        "libx265",
        "libvpx-vp9",
        "libsvtav1",
        "libaom-av1",
    ] {
        if list
            .lines()
            .any(|l| l.split_whitespace().nth(1) == Some(lib))
        {
            encoders.push(lib.to_string());
        }
    }
    Ok(Detected {
        ffmpeg_version: version_line,
        encoders,
    })
}

/// ffmpeg-энкодер, требуемый кодеку арены (`None` — внешний не нужен).
pub fn required_encoder(id: &str) -> Option<&'static str> {
    match id {
        "x264" => Some("libx264"),
        "x265" => Some("libx265"),
        "vp9" => Some("libvpx-vp9"),
        "svtav1" => Some("libsvtav1"),
        "aom" => Some("libaom-av1"),
        _ => None,
    }
}

/// Поиск бинаря `frc-v`: рядом с текущим exe, затем в PATH.
pub fn locate_frcv_bin(explicit: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(p) = explicit {
        if p.is_file() {
            return Ok(p.to_path_buf());
        }
        return Err(format!("--frcv-bin: файл не найден: {}", p.display()));
    }
    let exe_name = if cfg!(windows) { "frc-v.exe" } else { "frc-v" };
    if let Ok(me) = std::env::current_exe()
        && let Some(dir) = me.parent()
    {
        let sibling = dir.join(exe_name);
        if sibling.is_file() {
            return Ok(sibling);
        }
    }
    // PATH: доверяем резолвингу ОС.
    let probe = Command::new(exe_name).arg("--help").output();
    if probe.is_ok() {
        return Ok(PathBuf::from(exe_name));
    }
    Err(format!(
        "бинарь {exe_name} не найден рядом с полигоном и в PATH; соберите его: \
         cargo build --release -p frc-v-cli (или укажите --frcv-bin)"
    ))
}
