//! Раннер арены: изображение × участник × точка качества → encode, decode,
//! метрики. Замеры скорости — медиана wall-time по `--repeat` повторам
//! (процессы спавнятся последовательно: условия равные у всех участников).
//! Промежуточные файлы живут в work-каталоге и удаляются по мере
//! использования, если не просили `--keep-work`.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::codecs::{Contestant, Env, Kind};
use crate::corpus;
use crate::metrics::{self, Pixels};

pub const SCHEMA_VERSION: u32 = 1;

/// Снимок полного прогона арены (JSON, вход compare/report).
#[derive(Serialize, Deserialize)]
pub struct Snapshot {
    pub schema: u32,
    pub label: String,
    /// Unix-время создания, секунды UTC.
    pub created_unix: u64,
    pub tools: ToolInfo,
    pub config: RunConfig,
    pub runs: Vec<RunRecord>,
}

/// Провенанс инструментов прогона (воспроизводимость чисел).
#[derive(Serialize, Deserialize)]
pub struct ToolInfo {
    pub polygon: String,
    pub flora: String,
    pub ffmpeg: String,
    pub cjxl: String,
    pub ssimulacra2: String,
    pub butteraugli: String,
}

#[derive(Serialize, Deserialize)]
pub struct RunConfig {
    pub repeat: usize,
    pub external_metrics: bool,
    pub avif_cpu: u32,
    /// id участника → человекочитаемая метка (настройки).
    pub codec_labels: BTreeMap<String, String>,
    /// env сторон FRI: id → `K=V; K=V` (как передано процессу).
    pub fri_envs: BTreeMap<String, String>,
}

/// Одна точка RD-кривой одного участника на одном изображении.
#[derive(Serialize, Deserialize, Clone)]
pub struct RunRecord {
    pub image: String,
    pub class: String,
    pub width: u32,
    pub height: u32,
    pub codec: String,
    /// Параметр качества (FRI/WebP/JXL: quality 1..=100; JPEG: −q:v; AVIF: crf).
    pub q: u32,
    pub payload_bytes: u64,
    pub bpp: f64,
    pub psnr_rgb: f64,
    pub psnr_y: f64,
    pub ssim_db: f64,
    /// SSIMULACRA2 (выше = лучше); None — инструмент недоступен/упал.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s2: Option<f64>,
    /// butteraugli pnorm (ниже = лучше); None — инструмент недоступен/упал.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ba: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alpha_psnr: Option<f64>,
    /// Медиана wall-time процессов encode/decode, мс.
    pub enc_ms: f64,
    pub dec_ms: f64,
}

pub struct RunArgs {
    pub images_dir: PathBuf,
    pub work_dir: PathBuf,
    /// Стороны FRC-I (первой всегда идёт эталон `fri`).
    pub sides: Vec<Contestant>,
    /// Внешние кодеки (уже проверенные на доступность).
    pub externals: Vec<Contestant>,
    /// Ограничение по именам изображений (None — весь корпус).
    pub images: Option<Vec<String>>,
    /// Переопределение сетки качества: id участника → точки.
    pub points: BTreeMap<String, Vec<u32>>,
    /// Повторы encode/decode для медианы скорости.
    pub repeat: usize,
    pub label: String,
    pub keep_work: bool,
    /// Считать SSIMULACRA2/butteraugli (при доступности бинарей).
    pub external_metrics: bool,
    pub ssimulacra2_bin: String,
    pub butteraugli_bin: String,
    pub env: Env,
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn median(mut xs: Vec<f64>) -> f64 {
    xs.sort_by(|a, b| a.total_cmp(b));
    xs[xs.len() / 2]
}

/// Полный прогон арены.
pub fn run(args: &RunArgs) -> Result<Snapshot, String> {
    let mut catalog = corpus::catalog(&args.images_dir).map_err(|e| e.to_string())?;
    if let Some(filter) = &args.images {
        for name in filter {
            if !catalog.iter().any(|c| &c.name == name) {
                return Err(format!("неизвестное изображение: {name}"));
            }
        }
        catalog.retain(|c| filter.iter().any(|n| n == &c.name));
    }
    if catalog.is_empty() {
        return Err("корпус пуст".into());
    }

    let mut active: Vec<&Contestant> = args.sides.iter().collect();
    active.extend(args.externals.iter());
    if active.is_empty() {
        return Err("ни одного участника".into());
    }

    let s2_on = args.external_metrics && {
        let ok = metrics::ssimulacra2_available(&args.ssimulacra2_bin);
        if !ok {
            eprintln!("предупреждение: ssimulacra2 недоступен — метрика пропущена");
        }
        ok
    };
    let ba_on = args.external_metrics && {
        let ok = metrics::butteraugli_available(&args.butteraugli_bin);
        if !ok {
            eprintln!("предупреждение: butteraugli_main недоступен — метрика пропущена");
        }
        ok
    };

    fs::create_dir_all(&args.work_dir).map_err(|e| e.to_string())?;
    let mut runs: Vec<RunRecord> = Vec::new();

    for image in &catalog {
        let src = corpus::materialize(image, &args.images_dir)
            .map_err(|e| format!("{}: {e}", image.name))?;
        let reference = Pixels::load(&src)?;
        let pixels = f64::from(image.width) * f64::from(image.height);
        eprintln!(
            "изображение {} ({}x{}, класс {}{})",
            image.name,
            image.width,
            image.height,
            image.class,
            if image.has_alpha { ", альфа" } else { "" }
        );

        for codec in &active {
            // Альфа-изображения — только для сторон FRC-I: у конкурентов
            // поддержка альфы несопоставима (и метрики там иные).
            let is_fri = matches!(codec.kind, Kind::Fri { .. });
            if image.has_alpha && !is_fri {
                continue;
            }
            let points = args
                .points
                .get(&codec.id)
                .cloned()
                .unwrap_or_else(|| codec.default_points.clone());
            for &q in &points {
                let stem = format!("{}.{}.q{q}", image.name, codec.id);
                let bs = args.work_dir.join(format!("{stem}.{}", codec.ext));
                let dec = args.work_dir.join(format!("{stem}.dec.png"));

                let mut enc_times = Vec::with_capacity(args.repeat);
                let mut dec_times = Vec::with_capacity(args.repeat);
                for rep in 0..args.repeat.max(1) {
                    let enc = codec
                        .encode(&args.env, &src, &bs, q)
                        .map_err(|e| format!("{stem}: {e}"))?;
                    let payload = codec
                        .payload_bytes(&bs)
                        .map_err(|e| format!("{stem}: {e}"))?;
                    let dec_run = codec.decode(&args.env, &bs, &dec)?;
                    enc_times.push(enc.wall_secs * 1000.0);
                    dec_times.push(dec_run.wall_secs * 1000.0);
                    if rep == 0 {
                        // Метрики — по первому повтору (байты детерминированы).
                        let distorted = Pixels::load(&dec)?;
                        let quality = metrics::quality(&reference, &distorted)
                            .map_err(|e| format!("{stem}: {e}"))?;
                        let s2 = if s2_on {
                            match metrics::ssimulacra2(&args.ssimulacra2_bin, &src, &dec) {
                                Ok(v) => Some(v),
                                Err(e) => {
                                    eprintln!("предупреждение: {stem}: {e}");
                                    None
                                }
                            }
                        } else {
                            None
                        };
                        let ba = if ba_on {
                            match metrics::butteraugli(&args.butteraugli_bin, &src, &dec) {
                                Ok(v) => Some(v),
                                Err(e) => {
                                    eprintln!("предупреждение: {stem}: {e}");
                                    None
                                }
                            }
                        } else {
                            None
                        };
                        runs.push(RunRecord {
                            image: image.name.clone(),
                            class: image.class.clone(),
                            width: image.width,
                            height: image.height,
                            codec: codec.id.clone(),
                            q,
                            payload_bytes: payload,
                            bpp: payload as f64 * 8.0 / pixels,
                            psnr_rgb: quality.psnr_rgb,
                            psnr_y: quality.psnr_y,
                            ssim_db: quality.ssim_db,
                            s2,
                            ba,
                            alpha_psnr: quality.alpha_psnr,
                            enc_ms: 0.0,
                            dec_ms: 0.0,
                        });
                    }
                }
                let rec = runs.last_mut().expect("только что добавлена");
                rec.enc_ms = median(enc_times);
                rec.dec_ms = median(dec_times);
                eprintln!(
                    "  {:<8} q{:<3} {:>7} B | RGB {:>6.2} | Y {:>6.2} | SSIM {:>5.2}{}{} | enc {:>7.1} ms | dec {:>6.1} ms",
                    codec.id,
                    q,
                    rec.payload_bytes,
                    rec.psnr_rgb,
                    rec.psnr_y,
                    rec.ssim_db,
                    rec.s2
                        .map(|v| format!(" | S2 {v:>6.2}"))
                        .unwrap_or_default(),
                    rec.ba
                        .map(|v| format!(" | BA {v:>5.2}"))
                        .unwrap_or_default(),
                    rec.enc_ms,
                    rec.dec_ms,
                );
                if !args.keep_work {
                    let _ = fs::remove_file(&bs);
                    let _ = fs::remove_file(&dec);
                }
            }
        }
    }

    let mut codec_labels = BTreeMap::new();
    let mut fri_envs = BTreeMap::new();
    for c in &active {
        codec_labels.insert(c.id.clone(), c.label.clone());
        if let Kind::Fri { env, bitstream } = &c.kind {
            let mut parts: Vec<String> = env.iter().map(|(k, v)| format!("{k}={v}")).collect();
            if let Some(v) = bitstream {
                parts.push(format!("bitstream={v}"));
            }
            fri_envs.insert(c.id.clone(), parts.join("; "));
        }
    }

    Ok(Snapshot {
        schema: SCHEMA_VERSION,
        label: args.label.clone(),
        created_unix: now_unix(),
        tools: ToolInfo {
            polygon: format!("frc-i-polygon {}", env!("CARGO_PKG_VERSION")),
            flora: args.env.flora_bin.display().to_string(),
            ffmpeg: crate::codecs::detect_ffmpeg(&args.env.ffmpeg)
                .map(|i| i.version)
                .unwrap_or_else(|_| "—".into()),
            cjxl: if crate::codecs::tool_present(&args.env.cjxl) {
                args.env.cjxl.clone()
            } else {
                "—".into()
            },
            ssimulacra2: if s2_on {
                args.ssimulacra2_bin.clone()
            } else {
                "—".into()
            },
            butteraugli: if ba_on {
                args.butteraugli_bin.clone()
            } else {
                "—".into()
            },
        },
        config: RunConfig {
            repeat: args.repeat,
            external_metrics: args.external_metrics,
            avif_cpu: args.env.avif_cpu,
            codec_labels,
            fri_envs,
        },
        runs,
    })
}
