//! Участники арены. Все — внешние процессы: стороны FRC-I идут через
//! `flora-codec` (тот же харнесс, что у исторических чисел спеки; env-ручки
//! линии передаются процессу и читаются им один раз на старте), JPEG/WebP/
//! AVIF — через ffmpeg, JXL — нативными cjxl/djxl (ffmpeg libjxl ≠ cjxl,
//! см. урок §11.10 `documents/codecs/frc-i.md`).
//!
//! Размер — полный файл битстрима (FRI — сырой поток, JPEG — файл JPEG,
//! WebP — RIFF, AVIF — BMFF; контейнерный вклад AVIF задокументирован
//! в методике отчёта). Скорость — wall-time процесса, одинаково для всех.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

/// Внешние кодеки арены (порядок = порядок в отчётах).
pub const EXTERNAL_CODECS: &[&str] = &["jpeg", "webp", "avif", "jxl7", "jxl9"];

/// Окружение арены: пути к бинарям и настройки конкурентов.
pub struct Env {
    pub flora_bin: PathBuf,
    pub ffmpeg: String,
    pub cjxl: String,
    pub djxl: String,
    pub avif_cpu: u32,
}

/// Результат запуска процесса.
pub struct RunOutcome {
    pub wall_secs: f64,
}

/// Запуск с замером wall-time; ошибка — с хвостом stderr.
fn spawn(cmd: &mut Command, what: &str) -> Result<RunOutcome, String> {
    let t0 = Instant::now();
    let out = cmd.output().map_err(|e| format!("{what}: запуск: {e}"))?;
    let wall_secs = t0.elapsed().as_secs_f64();
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: String = err
            .trim()
            .chars()
            .rev()
            .take(400)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        return Err(format!("{what}: код {:?}: {tail}", out.status.code()));
    }
    Ok(RunOutcome { wall_secs })
}

/// Разновидность участника.
pub enum Kind {
    /// Сторона FRC-I: env-ручки кодера + опциональная явная версия битстрима.
    Fri {
        env: Vec<(String, String)>,
        bitstream: Option<u8>,
    },
    Jpeg,
    Webp,
    Avif,
    /// Нативный cjxl с заданным effort.
    Jxl {
        effort: u32,
    },
}

/// Участник арены: сетка качества по умолчанию и команды encode/decode.
pub struct Contestant {
    pub id: String,
    pub label: String,
    pub kind: Kind,
    pub default_points: Vec<u32>,
    /// Расширение файла битстрима.
    pub ext: &'static str,
}

/// Сторона FRC-I по умолчанию: публичный кодер без env-ручек (= текущая
/// замороженная калибровка; контроль байтов — golden-тестами `frc-i`).
pub fn default_fri_side() -> Contestant {
    Contestant {
        id: "fri".to_string(),
        label: format!("FRC-I {} (эталон, без ручек)", env!("CARGO_PKG_VERSION")),
        kind: Kind::Fri {
            env: Vec::new(),
            bitstream: None,
        },
        default_points: fri_points(),
        ext: "fri",
    }
}

fn fri_points() -> Vec<u32> {
    // Лестница перекрывает переключение 4:4:4→4:2:0 на q85 и рабочую зону
    // продукта (ленты ~q75, превью ~q45).
    vec![95, 90, 85, 80, 70, 60, 45, 30]
}

/// Парсит сторону FRC-I: `name[,КЛЮЧ=значение]...[,bitstream=N]`.
/// Ключи env обязаны начинаться с `FRC_I_` (защита от опечаток: неизвестная
/// ручка молча не действует, а арена обязана это ловить).
pub fn parse_fri_side(spec: &str) -> Result<Contestant, String> {
    let mut env_pairs = Vec::new();
    let mut bitstream = None;
    let mut tokens = spec.split(',').map(str::trim).filter(|t| !t.is_empty());
    let name = tokens
        .next()
        .ok_or_else(|| "пустая спецификация стороны".to_string())?;
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("недопустимое имя стороны `{name}`"));
    }
    if EXTERNAL_CODECS.contains(&name) || name == "fri" {
        return Err(format!(
            "имя стороны `{name}` зарезервировано (эталонная сторона `fri` и внешние кодеки)"
        ));
    }
    for tok in tokens {
        let (k, v) = tok.split_once('=').ok_or_else(|| {
            format!("сторона `{name}`: ожидается КЛЮЧ=значение, получено `{tok}`")
        })?;
        if k == "bitstream" {
            let v: u8 = v
                .parse()
                .map_err(|_| format!("сторона `{name}`: bitstream `{v}` не число 1..=255"))?;
            bitstream = Some(v);
            continue;
        }
        if !k.starts_with("FRC_I_") {
            return Err(format!(
                "сторона `{name}`: env-ключ `{k}` без префикса FRC_I_ (защита от опечаток)"
            ));
        }
        env_pairs.push((k.to_string(), v.to_string()));
    }
    let label = if env_pairs.is_empty() && bitstream.is_none() {
        format!("FRC-I сторона {name} (без ручек)")
    } else {
        let mut parts: Vec<String> = env_pairs
            .iter()
            .map(|(k, v)| format!("{}={}", k.trim_start_matches("FRC_I_RD_"), v))
            .collect();
        if let Some(v) = bitstream {
            parts.push(format!("bitstream {v}"));
        }
        format!("FRC-I сторона {name} ({})", parts.join(", "))
    };
    Ok(Contestant {
        id: name.to_string(),
        label,
        kind: Kind::Fri {
            env: env_pairs,
            bitstream,
        },
        default_points: fri_points(),
        ext: "fri",
    })
}

/// Внешний кодек по id (`EXTERNAL_CODECS`).
pub fn external(id: &str, env: &Env) -> Option<Contestant> {
    let c = match id {
        "jpeg" => Contestant {
            id: id.to_string(),
            label: "JPEG (ffmpeg mjpeg)".to_string(),
            kind: Kind::Jpeg,
            // -q:v 2..31 (меньше = лучше).
            default_points: vec![2, 4, 6, 9, 13, 18, 24, 29],
            ext: "mjpeg",
        },
        "webp" => Contestant {
            id: id.to_string(),
            label: "WebP (libwebp)".to_string(),
            kind: Kind::Webp,
            default_points: vec![95, 90, 85, 80, 70, 60, 45, 30],
            ext: "webp",
        },
        "avif" => Contestant {
            id: id.to_string(),
            label: format!("AVIF (libaom still, cpu-used {})", env.avif_cpu),
            kind: Kind::Avif,
            default_points: vec![10, 16, 22, 28, 34, 40, 46, 54],
            ext: "avif",
        },
        "jxl7" | "jxl9" => {
            let effort: u32 = id[3..].parse().ok()?;
            Contestant {
                id: id.to_string(),
                label: format!("JPEG XL (cjxl effort {effort})"),
                kind: Kind::Jxl { effort },
                default_points: vec![95, 90, 85, 80, 70, 60, 45, 30],
                ext: "jxl",
            }
        }
        _ => return None,
    };
    Some(c)
}

/// Требуемый энкодер ffmpeg для внешнего id (None — проверка не нужна).
pub fn required_ffmpeg_encoder(id: &str) -> Option<&'static str> {
    match id {
        "jpeg" => Some("mjpeg"),
        "webp" => Some("libwebp"),
        "avif" => Some("libaom-av1"),
        _ => None,
    }
}

/// Инструменты, нужные внешнему id помимо ffmpeg.
pub fn required_tools(id: &str) -> &'static [&'static str] {
    match id {
        "jxl7" | "jxl9" => &["cjxl", "djxl"],
        _ => &[],
    }
}

/// Сведения о ffmpeg: строка версии и список энкодеров.
pub struct FfmpegInfo {
    pub version: String,
    pub encoders: Vec<String>,
}

pub fn detect_ffmpeg(ffmpeg: &str) -> Result<FfmpegInfo, String> {
    let out = Command::new(ffmpeg)
        .args(["-hide_banner", "-version"])
        .output()
        .map_err(|e| format!("ffmpeg не найден: {e}"))?;
    let version = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or("ffmpeg")
        .to_string();
    let out = Command::new(ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .output()
        .map_err(|e| format!("ffmpeg -encoders: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let encoders = text
        .lines()
        .filter_map(|l| l.split_whitespace().nth(1).map(str::to_string))
        .collect();
    Ok(FfmpegInfo { version, encoders })
}

/// Бинарь доступен (spawn прошёл; код выхода не важен).
pub fn tool_present(tool: &str) -> bool {
    Command::new(tool).arg("--version").output().is_ok()
        || Command::new(tool).arg("--help").output().is_ok()
        || Command::new(tool).output().is_ok()
}

/// Поиск `flora-codec`: флаг → рядом с бинарём полигона (та же target-сборка)
/// → PATH.
pub fn locate_flora_bin(flag: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(p) = flag {
        if p.is_file() {
            return Ok(p.to_path_buf());
        }
        return Err(format!("--flora-bin: {} не файл", p.display()));
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let sibling = exe.with_file_name(if cfg!(windows) {
        "flora-codec.exe"
    } else {
        "flora-codec"
    });
    if sibling.is_file() {
        return Ok(sibling);
    }
    which_in_path("flora-codec").ok_or_else(|| {
        "flora-codec не найден (соберите: cargo build --release -p flora-codec-tools)".to_string()
    })
}

/// Аналог `which` без зависимостей.
fn which_in_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    std::env::split_paths(&path_var)
        .map(|dir| dir.join(&exe))
        .find(|p| p.is_file())
}

impl Contestant {
    /// Команда кодирования одной точки.
    pub fn encode(
        &self,
        env: &Env,
        src_png: &Path,
        out: &Path,
        q: u32,
    ) -> Result<RunOutcome, String> {
        let what = format!("{} encode q{q}", self.id);
        match &self.kind {
            Kind::Fri {
                env: pairs,
                bitstream,
            } => {
                let mut cmd = Command::new(&env.flora_bin);
                cmd.arg("image")
                    .arg("encode")
                    .arg(src_png)
                    .arg(out)
                    .arg("--quality")
                    .arg(q.to_string());
                if let Some(v) = bitstream {
                    cmd.arg("--bitstream").arg(v.to_string());
                }
                for (k, v) in pairs {
                    cmd.env(k, v);
                }
                spawn(&mut cmd, &what)
            }
            Kind::Jpeg => spawn(
                Command::new(&env.ffmpeg)
                    .args(["-y", "-v", "error", "-i"])
                    .arg(src_png)
                    .args(["-c:v", "mjpeg", "-q:v", &q.to_string()])
                    .arg(out),
                &what,
            ),
            Kind::Webp => spawn(
                Command::new(&env.ffmpeg)
                    .args(["-y", "-v", "error", "-i"])
                    .arg(src_png)
                    .args([
                        "-c:v",
                        "libwebp",
                        "-lossless",
                        "0",
                        "-quality",
                        &q.to_string(),
                    ])
                    .arg(out),
                &what,
            ),
            Kind::Avif => spawn(
                Command::new(&env.ffmpeg)
                    .args(["-y", "-v", "error", "-i"])
                    .arg(src_png)
                    .args([
                        "-c:v",
                        "libaom-av1",
                        "-still-picture",
                        "1",
                        "-cpu-used",
                        &env.avif_cpu.to_string(),
                        "-crf",
                        &q.to_string(),
                        "-pix_fmt",
                        "yuv420p",
                    ])
                    .arg(out),
                &what,
            ),
            Kind::Jxl { effort } => spawn(
                Command::new(&env.cjxl)
                    .arg(src_png)
                    .arg(out)
                    .arg("-q")
                    .arg(q.to_string())
                    .arg("-e")
                    .arg(effort.to_string()),
                &what,
            ),
        }
    }

    /// Команда декодирования в PNG.
    pub fn decode(
        &self,
        env: &Env,
        bitstream: &Path,
        out_png: &Path,
    ) -> Result<RunOutcome, String> {
        let what = format!("{} decode", self.id);
        match &self.kind {
            Kind::Fri { .. } => spawn(
                Command::new(&env.flora_bin)
                    .arg("image")
                    .arg("decode")
                    .arg(bitstream)
                    .arg(out_png),
                &what,
            ),
            Kind::Jpeg => spawn(
                Command::new(&env.ffmpeg)
                    .args(["-y", "-v", "error", "-f", "mjpeg", "-i"])
                    .arg(bitstream)
                    .args(["-frames:v", "1"])
                    .arg(out_png),
                &what,
            ),
            Kind::Webp | Kind::Avif => spawn(
                Command::new(&env.ffmpeg)
                    .args(["-y", "-v", "error", "-i"])
                    .arg(bitstream)
                    .args(["-frames:v", "1"])
                    .arg(out_png),
                &what,
            ),
            Kind::Jxl { .. } => spawn(Command::new(&env.djxl).arg(bitstream).arg(out_png), &what),
        }
    }

    /// Полезная нагрузка: размер файла битстрима (см. шапку модуля про AVIF).
    pub fn payload_bytes(&self, bitstream: &Path) -> std::io::Result<u64> {
        Ok(std::fs::metadata(bitstream)?.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_side_plain() {
        let c = parse_fri_side("exp1").unwrap();
        assert_eq!(c.id, "exp1");
        match c.kind {
            Kind::Fri { env, bitstream } => {
                assert!(env.is_empty());
                assert_eq!(bitstream, None);
            }
            _ => panic!("ожидалась Fri"),
        }
    }

    #[test]
    fn parse_side_env_and_bitstream() {
        let c =
            parse_fri_side("exp,FRC_I_RD_LAMBDA=0.05,FRC_I_RD_SPLIT8=1.5,bitstream=11").unwrap();
        match c.kind {
            Kind::Fri { env, bitstream } => {
                assert_eq!(env.len(), 2);
                assert_eq!(env[0], ("FRC_I_RD_LAMBDA".to_string(), "0.05".to_string()));
                assert_eq!(bitstream, Some(11));
            }
            _ => panic!("ожидалась Fri"),
        }
        assert!(c.label.contains("LAMBDA=0.05"));
    }

    #[test]
    fn parse_side_rejects_bad_env_prefix() {
        assert!(parse_fri_side("exp,LAMBDA=0.05").is_err());
        assert!(parse_fri_side("fri").is_err());
        assert!(parse_fri_side("jpeg").is_err());
        assert!(parse_fri_side("exp,FRC_I_RD_X").is_err());
    }

    #[test]
    fn external_ladders_cover_range() {
        let env = Env {
            flora_bin: PathBuf::new(),
            ffmpeg: "ffmpeg".to_string(),
            cjxl: "cjxl".to_string(),
            djxl: "djxl".to_string(),
            avif_cpu: 4,
        };
        for id in EXTERNAL_CODECS {
            let c = external(id, &env).unwrap();
            assert!(c.default_points.len() >= 6, "{id}");
        }
    }
}
