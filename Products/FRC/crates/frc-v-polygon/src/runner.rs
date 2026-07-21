//! Раннер арены: клип × кодек × точка качества → encode, decode, метрики.
//! Все промежуточные файлы живут в work-каталоге и удаляются по мере
//! использования (декоды больших y4m не копятся).

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::codecs::{self, Codec, EncodeJob, Env};
use crate::corpus;
use crate::metrics;

pub const SCHEMA_VERSION: u32 = 1;

/// Снимок полного прогона арены (JSON, вход compare/report).
#[derive(Serialize, Deserialize)]
pub struct Snapshot {
    pub schema: u32,
    pub label: String,
    /// Unix-время создания, секунды UTC.
    pub created_unix: u64,
    pub ffmpeg: String,
    pub config: RunConfig,
    pub runs: Vec<RunRecord>,
}

#[derive(Serialize, Deserialize)]
pub struct RunConfig {
    pub frames: usize,
    pub keyint: u32,
    pub frcv_speed: u8,
    pub frcv_ssim_tune: bool,
    pub tune_psnr: bool,
    pub vmaf: bool,
    /// id кодека → человекочитаемая метка (настройки).
    pub codec_labels: BTreeMap<String, String>,
}

/// Одна точка RD-кривой одного кодека на одном клипе.
#[derive(Serialize, Deserialize, Clone)]
pub struct RunRecord {
    pub clip: String,
    pub class: String,
    pub width: usize,
    pub height: usize,
    pub fps_num: u32,
    pub fps_den: u32,
    pub frames: usize,
    pub codec: String,
    /// Параметр качества (qp/crf).
    pub q: u32,
    pub payload_bytes: u64,
    pub kbps: f64,
    pub bpp: f64,
    pub psnr_y: f64,
    pub psnr_ov: f64,
    pub ssim_y: f64,
    pub ssim_ov: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vmaf: Option<f64>,
    pub enc_secs: f64,
    pub dec_secs: f64,
    pub enc_fps: f64,
    pub dec_fps: f64,
}

pub struct RunArgs {
    pub clips_dir: PathBuf,
    pub work_dir: PathBuf,
    pub codecs: Vec<String>,
    /// Ограничение по именам клипов (None — весь корпус).
    pub clips: Option<Vec<String>>,
    pub frames: usize,
    pub keyint: u32,
    pub vmaf: bool,
    /// Переопределение сетки качества: id кодека → точки.
    pub points: BTreeMap<String, Vec<u32>>,
    pub label: String,
    pub keep_work: bool,
    pub env: Env,
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Полный прогон арены.
pub fn run(args: &RunArgs) -> Result<Snapshot, String> {
    let detected = codecs::detect_ffmpeg(&args.env.ffmpeg)?;
    let vmaf_on = args.vmaf && {
        let ok = metrics::vmaf_available(&args.env.ffmpeg);
        if !ok {
            eprintln!("предупреждение: libvmaf недоступен в этой сборке ffmpeg — VMAF пропущен");
        }
        ok
    };

    let mut catalog = corpus::catalog(&args.clips_dir).map_err(|e| e.to_string())?;
    if let Some(filter) = &args.clips {
        for name in filter {
            if !catalog.iter().any(|c| &c.name == name) {
                return Err(format!("неизвестный клип: {name}"));
            }
        }
        catalog.retain(|c| filter.iter().any(|n| n == &c.name));
    }
    if catalog.is_empty() {
        return Err("корпус пуст".into());
    }

    // Кодеки: проверка доступности энкодеров ffmpeg.
    let mut active: Vec<Codec> = Vec::new();
    let mut labels = BTreeMap::new();
    for id in &args.codecs {
        let Some(codec) = Codec::by_id(id, &args.env) else {
            return Err(format!(
                "неизвестный кодек `{id}` (доступны: {})",
                codecs::ALL_CODECS.join(", ")
            ));
        };
        if let Some(required) = codecs::required_encoder(id)
            && !detected.encoders.iter().any(|e| e == required)
        {
            eprintln!("предупреждение: в ffmpeg нет {required} — кодек {id} пропущен");
            continue;
        }
        labels.insert(codec.id.to_string(), codec.label.clone());
        active.push(codec);
    }
    if active.is_empty() {
        return Err("ни одного доступного кодека".into());
    }

    fs::create_dir_all(&args.work_dir).map_err(|e| e.to_string())?;
    let mut runs: Vec<RunRecord> = Vec::new();

    for clip in &catalog {
        let (src, n_frames) =
            corpus::materialize(clip, &args.clips_dir, &args.work_dir, args.frames)
                .map_err(|e| format!("{}: {e}", clip.name))?;
        if n_frames < 8 {
            eprintln!(
                "предупреждение: {} — слишком мало кадров ({n_frames}), пропуск",
                clip.name
            );
            continue;
        }
        let fps = f64::from(clip.fps_num) / f64::from(clip.fps_den);
        let pixels_per_frame = (clip.width * clip.height) as f64;
        eprintln!(
            "клип {} ({}x{}, {n_frames} кадров, {:.3} fps, класс {})",
            clip.name, clip.width, clip.height, fps, clip.class
        );

        for codec in &active {
            let points = args
                .points
                .get(codec.id)
                .cloned()
                .unwrap_or_else(|| codec.default_points.clone());
            for &q in &points {
                let stem = format!("{}.{}.q{q}", clip.name, codec.id);
                let bs = args.work_dir.join(format!("{stem}.{}", codec.ext));
                let dec = args.work_dir.join(format!("{stem}.dec.y4m"));

                let job = EncodeJob {
                    input: &src,
                    output: &bs,
                    q,
                    keyint: args.keyint,
                    fps_num: clip.fps_num,
                    fps_den: clip.fps_den,
                    frames: n_frames,
                };
                let enc = codec.encode(&args.env, &job)?;
                let payload = codec
                    .payload_bytes(&bs, n_frames)
                    .map_err(|e| format!("{stem}: {e}"))?;
                let dec_run = codec.decode(&args.env, &bs, &dec)?;
                let quality = metrics::quality(&src, &dec)?;
                let vmaf_score = if vmaf_on {
                    match metrics::vmaf(&args.env.ffmpeg, &src, &dec, &args.work_dir) {
                        Ok(v) => Some(v),
                        Err(e) => {
                            eprintln!("предупреждение: {stem}: {e}");
                            None
                        }
                    }
                } else {
                    None
                };
                if !args.keep_work {
                    let _ = fs::remove_file(&bs);
                    let _ = fs::remove_file(&dec);
                }

                let kbps = payload as f64 * 8.0 * fps / n_frames as f64 / 1000.0;
                let record = RunRecord {
                    clip: clip.name.clone(),
                    class: clip.class.clone(),
                    width: clip.width,
                    height: clip.height,
                    fps_num: clip.fps_num,
                    fps_den: clip.fps_den,
                    frames: n_frames,
                    codec: codec.id.to_string(),
                    q,
                    payload_bytes: payload,
                    kbps,
                    bpp: payload as f64 * 8.0 / (pixels_per_frame * n_frames as f64),
                    psnr_y: quality.psnr_y,
                    psnr_ov: quality.psnr_ov,
                    ssim_y: quality.ssim_y,
                    ssim_ov: quality.ssim_ov,
                    vmaf: vmaf_score,
                    enc_secs: enc.wall_secs,
                    dec_secs: dec_run.wall_secs,
                    enc_fps: n_frames as f64 / enc.wall_secs.max(1e-9),
                    dec_fps: n_frames as f64 / dec_run.wall_secs.max(1e-9),
                };
                eprintln!(
                    "  {:<8} q{:<3} {:>9.1} kbps | Y {:>6.2} dB | ov {:>6.2} | SSIM {:.4}{} | enc {:>6.1} fps | dec {:>7.1} fps",
                    codec.id,
                    q,
                    record.kbps,
                    record.psnr_y,
                    record.psnr_ov,
                    record.ssim_y,
                    record
                        .vmaf
                        .map(|v| format!(" | VMAF {v:>5.1}"))
                        .unwrap_or_default(),
                    record.enc_fps,
                    record.dec_fps,
                );
                runs.push(record);
            }
        }
        if !args.keep_work {
            let _ = fs::remove_file(&src);
        }
    }

    Ok(Snapshot {
        schema: SCHEMA_VERSION,
        label: args.label.clone(),
        created_unix: now_unix(),
        ffmpeg: detected.ffmpeg_version,
        config: RunConfig {
            frames: args.frames,
            keyint: args.keyint,
            frcv_speed: args.env.frcv_speed,
            frcv_ssim_tune: args.env.frcv_ssim_tune,
            tune_psnr: args.env.tune_psnr,
            vmaf: vmaf_on,
            codec_labels: labels,
        },
        runs,
    })
}
