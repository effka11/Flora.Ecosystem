//! CLI кросс-кодек полигона FRC-V.
//!
//! Типовой цикл:
//! ```text
//! cargo build --release -p frc-v-cli -p frc-v-polygon
//! frc-v-polygon fetch                 # эталонные клипы xiph (опционально)
//! frc-v-polygon run --label baseline  # полный прогон, polygon-out/
//! ... правим энкодер ...
//! frc-v-polygon run --label v2 --out polygon-out-v2
//! frc-v-polygon compare polygon-out/snapshot.json polygon-out-v2/snapshot.json
//! ```

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use clap::{Parser, Subcommand};
use frc_v_polygon::codecs::{self, Env};
use frc_v_polygon::report::{self, CompareTolerance};
use frc_v_polygon::runner::{self, RunArgs, Snapshot};
use frc_v_polygon::{corpus, metrics};

type CliResult<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Parser)]
#[command(
    name = "frc-v-polygon",
    version,
    about = "Кросс-кодек полигон FRC-V: RD-свипы против x264/x265/VP9/AV1, BD-rate, отчёты"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
#[allow(clippy::large_enum_variant)] // CLI-энум живёт в одном экземпляре
enum Cmd {
    /// Перечислить корпус и доступные кодеки
    List {
        /// Каталог эталонных клипов (*.y4m)
        #[arg(long, default_value = "polygon-clips")]
        clips_dir: PathBuf,
        /// Путь к ffmpeg
        #[arg(long, default_value = "ffmpeg")]
        ffmpeg: String,
    },
    /// Скачать эталонные клипы xiph/derf (через curl)
    Fetch {
        #[arg(long, default_value = "polygon-clips")]
        clips_dir: PathBuf,
        /// Ограничить список (имена через запятую)
        #[arg(long, value_delimiter = ',')]
        only: Option<Vec<String>>,
    },
    /// Прогнать арену и записать отчёт
    Run {
        #[arg(long, default_value = "polygon-clips")]
        clips_dir: PathBuf,
        /// Каталог отчёта (snapshot.json, report.md, plots/)
        #[arg(long, default_value = "polygon-out")]
        out: PathBuf,
        /// Рабочий каталог (по умолчанию <out>/work)
        #[arg(long)]
        work_dir: Option<PathBuf>,
        /// Кодеки через запятую (frcv,x264,x265,vp9,svtav1,aom)
        #[arg(long, value_delimiter = ',')]
        codecs: Option<Vec<String>>,
        /// Ограничить прогон клипами (имена через запятую)
        #[arg(long, value_delimiter = ',')]
        clips: Option<Vec<String>>,
        /// Максимум кадров с клипа
        #[arg(long, default_value_t = 96)]
        frames: usize,
        /// Интервал ключевых кадров (общий для всех кодеков)
        #[arg(long, default_value_t = 48)]
        keyint: u32,
        /// Пресет скорости FRC-V (0 — полный RDO)
        #[arg(long, default_value_t = 1)]
        frcv_speed: u8,
        /// Психовизуальный RDO FRC-V (--ssim-tune энкодера)
        #[arg(long)]
        frcv_ssim_tune: bool,
        /// Не передавать конкурентам tune=psnr (их психовизуальные дефолты)
        #[arg(long)]
        no_tune_psnr: bool,
        /// Пресет SVT-AV1
        #[arg(long, default_value_t = 6)]
        svt_preset: u32,
        /// cpu-used libaom
        #[arg(long, default_value_t = 6)]
        aom_cpu: u32,
        /// Отключить VMAF
        #[arg(long)]
        no_vmaf: bool,
        /// Переопределить сетку качества: codec=q1,q2,... (можно повторять)
        #[arg(long)]
        points: Vec<String>,
        /// Метка снимка
        #[arg(long)]
        label: Option<String>,
        /// Baseline-снимок: после прогона напечатать сравнение; ненулевой
        /// код выхода при регрессиях FRC-V
        #[arg(long)]
        baseline: Option<PathBuf>,
        /// Дополнить снимок точками кодеков из старого снимка (кодеки, не
        /// вошедшие в --codecs). Ускоряет итерации: `--codecs frcv --reuse
        /// base/snapshot.json` перегоняет только FRC-V, конкуренты берутся
        /// из кэша
        #[arg(long)]
        reuse: Option<PathBuf>,
        /// Быстрый режим: 48 кадров, прореженные точки
        #[arg(long)]
        quick: bool,
        /// Не удалять рабочие файлы (битстримы, декоды)
        #[arg(long)]
        keep_work: bool,
        #[arg(long, default_value = "ffmpeg")]
        ffmpeg: String,
        /// Путь к бинарю frc-v (по умолчанию — рядом с полигоном или PATH)
        #[arg(long)]
        frcv_bin: Option<PathBuf>,
    },
    /// Сравнить два снимка (прогресс FRC-V, регрессии)
    Compare {
        old: PathBuf,
        new: PathBuf,
        /// Допуск деградации self-BD-rate на клипе, %
        #[arg(long, default_value_t = 2.0)]
        tol_clip: f64,
        /// Допуск средней деградации, %
        #[arg(long, default_value_t = 0.5)]
        tol_mean: f64,
    },
    /// Перегенерировать report.md и графики из снимка
    Report {
        snapshot: PathBuf,
        #[arg(long, default_value = "polygon-out")]
        out: PathBuf,
    },
}

fn main() {
    if let Err(e) = run() {
        eprintln!("frc-v-polygon: ошибка: {e}");
        std::process::exit(1);
    }
}

fn run() -> CliResult<()> {
    match Cli::parse().cmd {
        Cmd::List { clips_dir, ffmpeg } => cmd_list(&clips_dir, &ffmpeg),
        Cmd::Fetch { clips_dir, only } => cmd_fetch(&clips_dir, only.as_deref()),
        Cmd::Run {
            clips_dir,
            out,
            work_dir,
            codecs,
            clips,
            frames,
            keyint,
            frcv_speed,
            frcv_ssim_tune,
            no_tune_psnr,
            svt_preset,
            aom_cpu,
            no_vmaf,
            points,
            label,
            baseline,
            reuse,
            quick,
            keep_work,
            ffmpeg,
            frcv_bin,
        } => {
            let frcv_bin = codecs::locate_frcv_bin(frcv_bin.as_deref())?;
            let env = Env {
                ffmpeg,
                frcv_bin,
                frcv_speed,
                frcv_ssim_tune,
                tune_psnr: !no_tune_psnr,
                svt_preset,
                aom_cpu_used: aom_cpu,
            };
            let mut points_map = parse_points(&points)?;
            let codec_ids: Vec<String> = codecs
                .unwrap_or_else(|| codecs::ALL_CODECS.iter().map(|s| s.to_string()).collect());
            let frames = if quick { frames.min(48) } else { frames };
            if quick {
                // Прореживаем сетки по умолчанию: каждая вторая точка.
                for id in &codec_ids {
                    if !points_map.contains_key(id.as_str())
                        && let Some(c) = codecs::Codec::by_id(id, &env)
                    {
                        points_map.insert(
                            id.clone(),
                            c.default_points.iter().copied().step_by(2).collect(),
                        );
                    }
                }
            }
            let label =
                label.unwrap_or_else(|| format!("frc-v-polygon {}", env!("CARGO_PKG_VERSION")));
            let args = RunArgs {
                clips_dir,
                work_dir: work_dir.unwrap_or_else(|| out.join("work")),
                codecs: codec_ids,
                clips,
                frames,
                keyint,
                vmaf: !no_vmaf,
                points: points_map,
                label,
                keep_work,
                env,
            };
            let mut snapshot = runner::run(&args)?;
            if let Some(reuse_path) = reuse {
                let donor = load_snapshot(&reuse_path)?;
                merge_reused(&mut snapshot, donor, &args.codecs);
            }
            report::write_all(&out, &snapshot)?;
            if !keep_work {
                let _ = fs::remove_dir_all(&args.work_dir);
            }
            print!("{}", report::summary_text(&snapshot));
            println!(
                "\nотчёт: {} | снимок: {}",
                out.join("report.md").display(),
                out.join("snapshot.json").display()
            );
            if let Some(base) = baseline {
                let old = load_snapshot(&base)?;
                let tol = CompareTolerance::default();
                let (text, regressions) = report::compare_text(&old, &snapshot, &tol);
                println!("\n{text}");
                fail_on_regressions(regressions)?;
            }
            Ok(())
        }
        Cmd::Compare {
            old,
            new,
            tol_clip,
            tol_mean,
        } => {
            let old = load_snapshot(&old)?;
            let new = load_snapshot(&new)?;
            let tol = CompareTolerance {
                per_clip: tol_clip,
                mean: tol_mean,
            };
            let (text, regressions) = report::compare_text(&old, &new, &tol);
            print!("{text}");
            fail_on_regressions(regressions)
        }
        Cmd::Report { snapshot, out } => {
            let s = load_snapshot(&snapshot)?;
            report::write_all(&out, &s)?;
            println!("отчёт перегенерирован: {}", out.join("report.md").display());
            Ok(())
        }
    }
}

fn cmd_list(clips_dir: &Path, ffmpeg: &str) -> CliResult<()> {
    println!("корпус:");
    for c in corpus::catalog(clips_dir)? {
        let source = match c.source {
            corpus::ClipSource::Synth(_) => "синтетика",
            corpus::ClipSource::File(_) => "файл",
        };
        println!(
            "  {:<24} {:<10} {}x{}{} [{source}]",
            c.name,
            c.class,
            c.width,
            c.height,
            if c.frames > 0 {
                format!(", {} кадров", c.frames)
            } else {
                String::new()
            },
        );
    }
    match codecs::detect_ffmpeg(ffmpeg) {
        Ok(d) => {
            println!("\n{}", d.ffmpeg_version);
            println!("энкодеры ffmpeg: {}", d.encoders.join(", "));
            println!(
                "libvmaf: {}",
                if metrics::vmaf_available(ffmpeg) {
                    "да"
                } else {
                    "нет"
                }
            );
        }
        Err(e) => println!("\nffmpeg: {e}"),
    }
    match codecs::locate_frcv_bin(None) {
        Ok(p) => println!("frc-v: {}", p.display()),
        Err(e) => println!("frc-v: {e}"),
    }
    Ok(())
}

fn cmd_fetch(clips_dir: &Path, only: Option<&[String]>) -> CliResult<()> {
    fs::create_dir_all(clips_dir)?;
    let mut fetched = 0usize;
    for (name, url) in corpus::FETCH_MANIFEST {
        if let Some(filter) = only
            && !filter.iter().any(|n| n == name)
        {
            continue;
        }
        let dst = clips_dir.join(format!("{name}.y4m"));
        if dst.is_file() {
            println!("{name}: уже скачан");
            continue;
        }
        println!("{name}: скачивание {url}");
        let tmp = clips_dir.join(format!("{name}.y4m.part"));
        let status = Command::new("curl")
            .arg("--fail")
            .arg("--location")
            .arg("--silent")
            .arg("--show-error")
            .args(["--connect-timeout", "20"])
            .arg("--output")
            .arg(&tmp)
            .arg(*url)
            .status()
            .map_err(|e| format!("curl не найден: {e}"))?;
        if !status.success() {
            let _ = fs::remove_file(&tmp);
            eprintln!("{name}: скачивание не удалось (curl {status})");
            continue;
        }
        fs::rename(&tmp, &dst)?;
        println!(
            "{name}: ok ({} МБ)",
            fs::metadata(&dst)?.len() / 1024 / 1024
        );
        fetched += 1;
    }
    println!("готово, новых клипов: {fetched}");
    Ok(())
}

fn parse_points(specs: &[String]) -> CliResult<BTreeMap<String, Vec<u32>>> {
    let mut map = BTreeMap::new();
    for spec in specs {
        let (codec, list) = spec
            .split_once('=')
            .ok_or_else(|| format!("--points: ожидается codec=q1,q2 — получено `{spec}`"))?;
        let points: Result<Vec<u32>, _> = list.split(',').map(str::parse).collect();
        map.insert(
            codec.to_string(),
            points.map_err(|_| format!("--points {spec}: не числа"))?,
        );
    }
    Ok(map)
}

fn load_snapshot(path: &PathBuf) -> CliResult<Snapshot> {
    let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?)
}

/// Дополняет свежий снимок точками кодеков из донор-снимка, которых не было в
/// этом прогоне (`ran_codecs`). Основа флага `--reuse`: перегоняем только
/// FRC-V, а конкурентов берём из кэша предыдущего снимка — на порядок быстрее
/// на итерациях энкодера. Переносятся только клипы, реально прогнанные в этот
/// раз (иначе отчёт распух бы клипами без кривой FRC-V), и метки (`codec_labels`)
/// перенесённых кодеков.
fn merge_reused(snapshot: &mut Snapshot, donor: Snapshot, ran_codecs: &[String]) {
    let ran: BTreeSet<&str> = ran_codecs.iter().map(String::as_str).collect();
    let fresh_clips: BTreeSet<String> = snapshot.runs.iter().map(|r| r.clip.clone()).collect();
    let mut reused_codecs: BTreeSet<String> = BTreeSet::new();
    for r in donor.runs {
        if !ran.contains(r.codec.as_str()) && fresh_clips.contains(r.clip.as_str()) {
            reused_codecs.insert(r.codec.clone());
            snapshot.runs.push(r);
        }
    }
    for (codec, label) in donor.config.codec_labels {
        if reused_codecs.contains(&codec) {
            snapshot.config.codec_labels.entry(codec).or_insert(label);
        }
    }
}

fn fail_on_regressions(regressions: Vec<String>) -> CliResult<()> {
    if regressions.is_empty() {
        println!("регрессий нет");
        Ok(())
    } else {
        for r in &regressions {
            eprintln!("РЕГРЕССИЯ: {r}");
        }
        Err(format!("{} регрессий FRC-V против baseline", regressions.len()).into())
    }
}
