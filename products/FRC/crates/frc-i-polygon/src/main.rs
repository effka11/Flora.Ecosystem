//! CLI полигона FRC-I.
//!
//! Типовой цикл линии (калибровка кодера, см. frc-i.md §11):
//! ```text
//! cargo build --release -p flora-codec-tools -p frc-i-polygon
//! frc-i-polygon fetch --only kodak          # эталонный корпус (опционально)
//! frc-i-polygon run --label base            # эталон: fri + конкуренты
//! frc-i-polygon run --fri-only --label exp1 \
//!     --side "exp1,FRC_I_RD_SPLIT8=1.5"     # A/B: BD(exp1 vs fri) в сводке
//! frc-i-polygon compare polygon-out/snapshot.json polygon-out-exp1/snapshot.json
//! ```

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use clap::{Parser, Subcommand};
use frc_i_polygon::codecs::{self, Contestant, Env};
use frc_i_polygon::corpus;
use frc_i_polygon::report::{self, CompareTolerance};
use frc_i_polygon::runner::{self, RunArgs, Snapshot};

type CliResult<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Parser)]
#[command(
    name = "frc-i-polygon",
    version,
    about = "Полигон FRC-I: A/B калибровок кодера и прогоны против JPEG/WebP/AVIF/JXL, BD-rate, размер лестницы, iso-size, отчёты"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
#[allow(clippy::large_enum_variant)] // CLI-энум живёт в одном экземпляре
enum Cmd {
    /// Перечислить корпус и доступность инструментов
    List {
        /// Каталог корпуса (PNG + synth-кэш)
        #[arg(long, default_value = "polygon-images")]
        images_dir: PathBuf,
        /// Путь к ffmpeg
        #[arg(long, default_value = "ffmpeg")]
        ffmpeg: String,
    },
    /// Скачать эталонные наборы (через curl)
    Fetch {
        #[arg(long, default_value = "polygon-images")]
        images_dir: PathBuf,
        /// Ограничить список наборов (kodak,picsum)
        #[arg(long, value_delimiter = ',')]
        only: Option<Vec<String>>,
    },
    /// Прогнать арену и записать отчёт
    Run {
        #[arg(long, default_value = "polygon-images")]
        images_dir: PathBuf,
        /// Каталог отчёта (snapshot.json, report.md, plots/)
        #[arg(long, default_value = "polygon-out-i")]
        out: PathBuf,
        /// Рабочий каталог (по умолчанию <out>/work)
        #[arg(long)]
        work_dir: Option<PathBuf>,
        /// Сторона FRC-I: `name[,FRC_I_КЛЮЧ=значение]...[,bitstream=N]`;
        /// повторяемо. Без --side — только эталон `fri`
        #[arg(long)]
        side: Vec<String>,
        /// Внешние кодеки через запятую (jpeg,webp,avif,jxl7,jxl9);
        /// по умолчанию — все доступные
        #[arg(long, value_delimiter = ',')]
        codecs: Option<Vec<String>>,
        /// Только стороны FRC-I (без внешних кодеков) — режим A/B свипов
        #[arg(long)]
        fri_only: bool,
        /// Ограничить прогон изображениями (имена через запятую)
        #[arg(long, value_delimiter = ',')]
        images: Option<Vec<String>>,
        /// Переопределить сетку качества: codec=q1,q2,... (можно повторять)
        #[arg(long)]
        points: Vec<String>,
        /// Повторы encode/decode на точку (медиана скорости)
        #[arg(long, default_value_t = 1)]
        repeat: usize,
        /// Метка снимка
        #[arg(long)]
        label: Option<String>,
        /// Baseline-снимок: после прогона напечатать сравнение; ненулевой
        /// код выхода при регрессиях
        #[arg(long)]
        baseline: Option<PathBuf>,
        /// Быстрый режим: прореженные точки, без тяжёлого класса scale
        #[arg(long)]
        quick: bool,
        /// Не удалять рабочие файлы (битстримы, декоды)
        #[arg(long)]
        keep_work: bool,
        /// Не считать SSIMULACRA2/butteraugli
        #[arg(long)]
        no_external_metrics: bool,
        /// cpu-used libaom для AVIF
        #[arg(long, default_value_t = 4)]
        avif_cpu: u32,
        /// Путь к бинарю flora-codec (по умолчанию — рядом с полигоном или PATH)
        #[arg(long)]
        flora_bin: Option<PathBuf>,
        #[arg(long, default_value = "ffmpeg")]
        ffmpeg: String,
        #[arg(long, default_value = "cjxl")]
        cjxl: String,
        #[arg(long, default_value = "djxl")]
        djxl: String,
        #[arg(long, default_value = "ssimulacra2")]
        ssimulacra2: String,
        #[arg(long, default_value = "butteraugli_main")]
        butteraugli: String,
    },
    /// Сравнить два снимка (прогресс/регрессии общих участников)
    Compare {
        old: PathBuf,
        new: PathBuf,
        /// Допуск деградации self-BD-rate на изображении, %
        #[arg(long, default_value_t = 2.0)]
        tol_image: f64,
        /// Допуск средней деградации, %
        #[arg(long, default_value_t = 0.5)]
        tol_mean: f64,
        /// Допуск сдвига размера лестницы, доля (0.02 = ±2%)
        #[arg(long, default_value_t = 0.02)]
        tol_ladder: f64,
    },
    /// Перегенерировать report.md и графики из снимка
    Report {
        snapshot: PathBuf,
        #[arg(long, default_value = "polygon-out-i")]
        out: PathBuf,
    },
}

fn main() {
    if let Err(e) = run() {
        eprintln!("frc-i-polygon: ошибка: {e}");
        std::process::exit(1);
    }
}

fn run() -> CliResult<()> {
    match Cli::parse().cmd {
        Cmd::List { images_dir, ffmpeg } => cmd_list(&images_dir, &ffmpeg),
        Cmd::Fetch { images_dir, only } => cmd_fetch(&images_dir, only.as_deref()),
        Cmd::Run {
            images_dir,
            out,
            work_dir,
            side,
            codecs,
            fri_only,
            images,
            points,
            repeat,
            label,
            baseline,
            quick,
            keep_work,
            no_external_metrics,
            avif_cpu,
            flora_bin,
            ffmpeg,
            cjxl,
            djxl,
            ssimulacra2,
            butteraugli,
        } => {
            let env = Env {
                flora_bin: codecs::locate_flora_bin(flora_bin.as_deref())?,
                ffmpeg,
                cjxl,
                djxl,
                avif_cpu,
            };
            // Стороны FRC-I: эталон всегда первым.
            let mut sides: Vec<Contestant> = vec![codecs::default_fri_side()];
            for spec in &side {
                let c = codecs::parse_fri_side(spec)?;
                if sides.iter().any(|s| s.id == c.id) {
                    return Err(format!("дубликат стороны `{}`", c.id).into());
                }
                sides.push(c);
            }
            // Внешние кодеки: только доступные, с предупреждениями.
            let mut externals: Vec<Contestant> = Vec::new();
            if !fri_only {
                let detected = codecs::detect_ffmpeg(&env.ffmpeg)?;
                let ids = codecs.unwrap_or_else(|| {
                    codecs::EXTERNAL_CODECS
                        .iter()
                        .map(|s| s.to_string())
                        .collect()
                });
                for id in &ids {
                    let Some(c) = codecs::external(id, &env) else {
                        return Err(format!(
                            "неизвестный кодек `{id}` (доступны: {})",
                            codecs::EXTERNAL_CODECS.join(", ")
                        )
                        .into());
                    };
                    if let Some(required) = codecs::required_ffmpeg_encoder(id)
                        && !detected.encoders.iter().any(|e| e == required)
                    {
                        eprintln!("предупреждение: в ffmpeg нет {required} — кодек {id} пропущен");
                        continue;
                    }
                    let missing: Vec<&str> = codecs::required_tools(id)
                        .iter()
                        .copied()
                        .filter(|t| !codecs::tool_present(t))
                        .collect();
                    if !missing.is_empty() {
                        eprintln!(
                            "предупреждение: {} не найден — кодек {id} пропущен",
                            missing.join(", ")
                        );
                        continue;
                    }
                    externals.push(c);
                }
            }
            let mut points_map = parse_points(&points)?;
            let mut images_filter = images;
            if quick {
                // Прореживаем сетки по умолчанию: каждая вторая точка;
                // тяжёлый класс scale выбывает из быстрого режима.
                for c in sides.iter().chain(externals.iter()) {
                    if !points_map.contains_key(&c.id) {
                        points_map.insert(
                            c.id.clone(),
                            c.default_points.iter().copied().step_by(2).collect(),
                        );
                    }
                }
                let heavy: Vec<String> = corpus::catalog(&images_dir)?
                    .into_iter()
                    .filter(|i| i.class == "scale")
                    .map(|i| i.name)
                    .collect();
                let mut filter = images_filter.unwrap_or_else(|| {
                    corpus::catalog(&images_dir)
                        .map(|c| c.into_iter().map(|i| i.name).collect())
                        .unwrap_or_default()
                });
                filter.retain(|n| !heavy.contains(n));
                images_filter = Some(filter);
            }
            let label =
                label.unwrap_or_else(|| format!("frc-i-polygon {}", env!("CARGO_PKG_VERSION")));
            let args = RunArgs {
                images_dir,
                work_dir: work_dir.unwrap_or_else(|| out.join("work")),
                sides,
                externals,
                images: images_filter,
                points: points_map,
                repeat,
                label,
                keep_work,
                external_metrics: !no_external_metrics,
                ssimulacra2_bin: ssimulacra2,
                butteraugli_bin: butteraugli,
                env,
            };
            let snapshot = runner::run(&args)?;
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
            tol_image,
            tol_mean,
            tol_ladder,
        } => {
            let old = load_snapshot(&old)?;
            let new = load_snapshot(&new)?;
            let tol = CompareTolerance {
                per_image: tol_image,
                mean: tol_mean,
                ladder: tol_ladder,
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

fn cmd_list(images_dir: &Path, ffmpeg: &str) -> CliResult<()> {
    println!("корпус:");
    for c in corpus::catalog(images_dir)? {
        let source = match c.source {
            corpus::ImageSource::Synth(_) => "синтетика",
            corpus::ImageSource::File(_) => "файл",
        };
        println!(
            "  {:<24} {:<10} {}x{}{} [{source}]",
            c.name,
            c.class,
            c.width,
            c.height,
            if c.has_alpha { ", альфа" } else { "" },
        );
    }
    match codecs::detect_ffmpeg(ffmpeg) {
        Ok(d) => {
            println!("\n{}", d.version);
            for id in codecs::EXTERNAL_CODECS {
                if let Some(req) = codecs::required_ffmpeg_encoder(id) {
                    println!(
                        "  {id}: энкодер {req} — {}",
                        if d.encoders.iter().any(|e| e == req) {
                            "да"
                        } else {
                            "нет"
                        }
                    );
                }
            }
        }
        Err(e) => println!("\nffmpeg: {e}"),
    }
    for tool in ["cjxl", "djxl", "ssimulacra2", "butteraugli_main"] {
        println!(
            "{tool}: {}",
            if codecs::tool_present(tool) {
                "да"
            } else {
                "нет"
            }
        );
    }
    match codecs::locate_flora_bin(None) {
        Ok(p) => println!("flora-codec: {}", p.display()),
        Err(e) => println!("flora-codec: {e}"),
    }
    Ok(())
}

fn cmd_fetch(images_dir: &Path, only: Option<&[String]>) -> CliResult<()> {
    fs::create_dir_all(images_dir)?;
    let want = |set: &str| only.is_none_or(|f| f.iter().any(|s| s == set));
    let mut fetched = 0usize;
    if want("kodak") {
        for (idx, name) in corpus::kodak_names().iter().enumerate() {
            let dst = images_dir.join(format!("{name}.png"));
            if dst.is_file() {
                continue;
            }
            fetch_kodak_frame(idx, name, &dst)?;
            fetched += 1;
        }
    }
    if want("picsum") {
        for n in 1..=corpus::PICSUM_COUNT {
            let dst = images_dir.join(format!("picsum{n:02}.png"));
            if dst.is_file() {
                continue;
            }
            let jpg = images_dir.join(format!("picsum{n:02}.jpg"));
            fetch_url_to(&corpus::picsum_url(n), &jpg)?;
            // Конвертация JPEG → PNG (корпус хранится в PNG единообразно).
            let img = image::ImageReader::open(&jpg)?
                .decode()
                .map_err(|e| format!("{}: {e}", jpg.display()))?;
            let rgb = img.to_rgb8();
            let (w, h) = rgb.dimensions();
            image::save_buffer(&dst, &rgb, w, h, image::ExtendedColorType::Rgb8)?;
            let _ = fs::remove_file(&jpg);
            fetched += 1;
        }
    }
    println!("готово, новых изображений: {fetched}");
    Ok(())
}

fn fetch_url(url: &str, dst: &Path) -> CliResult<()> {
    fetch_url_to(url, dst)
}

/// Кадр Kodak: перебор зеркал, приём только при каноническом размере файла.
fn fetch_kodak_frame(idx: usize, name: &str, dst: &Path) -> CliResult<()> {
    let expect = corpus::KODAK_SIZES[idx];
    let mut errs = Vec::new();
    for base in corpus::KODAK_MIRRORS {
        let url = format!("{base}/{name}.png");
        match fetch_url(&url, dst) {
            Ok(()) => {}
            Err(e) => {
                errs.push(format!("{url}: {e}"));
                continue;
            }
        }
        let len = fs::metadata(dst).map(|m| m.len()).unwrap_or(0);
        if len == expect {
            return Ok(());
        }
        errs.push(format!("{url}: размер {len} != канонического {expect}"));
        let _ = fs::remove_file(dst);
    }
    Err(format!("{name}: все зеркала отказали — {}", errs.join("; ")).into())
}

fn fetch_url_to(url: &str, dst: &Path) -> CliResult<()> {
    println!("{}: скачивание {url}", dst.display());
    let tmp = dst.with_extension("part");
    let status = Command::new("curl")
        .arg("--fail")
        .arg("--location")
        .arg("--silent")
        .arg("--show-error")
        .args(["--connect-timeout", "20"])
        .arg("--output")
        .arg(&tmp)
        .arg(url)
        .status()
        .map_err(|e| format!("curl не найден: {e}"))?;
    if !status.success() {
        let _ = fs::remove_file(&tmp);
        return Err(format!("скачивание не удалось (curl {status}): {url}").into());
    }
    fs::rename(&tmp, dst)?;
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

fn fail_on_regressions(regressions: Vec<String>) -> CliResult<()> {
    if regressions.is_empty() {
        println!("регрессий нет");
        Ok(())
    } else {
        for r in &regressions {
            eprintln!("РЕГРЕССИЯ: {r}");
        }
        Err(format!("{} регрессий против baseline", regressions.len()).into())
    }
}
