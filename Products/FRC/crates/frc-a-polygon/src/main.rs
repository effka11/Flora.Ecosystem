//! CLI полигона FRC-A: прогон корпуса, JSON-снимки, сравнение с baseline,
//! экспорт WAV для прослушивания.

use std::fs;
use std::path::{Path, PathBuf};

use clap::{Parser, Subcommand};
use frc_a_polygon::corpus;
use frc_a_polygon::report::{self, Snapshot, Tolerance};
use frc_a_polygon::runner::{self, EncoderVariant};

type CliResult<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Parser)]
#[command(
    name = "frc-a-polygon",
    version,
    about = "Полигон качества FRC-A: корпус, метрики, регрессии"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Перечислить кейсы корпуса
    List,
    /// Прогнать корпус и напечатать таблицу метрик
    Run {
        /// Битрейты (kbps) через запятую вместо сетки по умолчанию
        #[arg(long, value_delimiter = ',')]
        bitrates: Option<Vec<u32>>,
        /// Ограничить прогон кейсами (имена через запятую)
        #[arg(long, value_delimiter = ',')]
        items: Option<Vec<String>>,
        /// Отключить детектор транзиентов (A/B)
        #[arg(long)]
        no_transients: bool,
        /// Отключить VBR (A/B)
        #[arg(long)]
        no_vbr: bool,
        /// Записать JSON-снимок результатов
        #[arg(long)]
        json: Option<PathBuf>,
        /// Метка снимка (по умолчанию — версия крейта)
        #[arg(long)]
        label: Option<String>,
        /// Сравнить с baseline-снимком; ненулевой код выхода при регрессиях
        #[arg(long)]
        baseline: Option<PathBuf>,
        /// Каталог для WAV (эталон + декод) — прослушивание
        #[arg(long)]
        wav_dir: Option<PathBuf>,
    },
    /// Сравнить два JSON-снимка (без прогона)
    Compare { old: PathBuf, new: PathBuf },
}

fn main() {
    if let Err(e) = run() {
        eprintln!("frc-a-polygon: ошибка: {e}");
        std::process::exit(1);
    }
}

fn run() -> CliResult<()> {
    match Cli::parse().cmd {
        Cmd::List => {
            for item in corpus::full_corpus() {
                let secs =
                    item.pcm.len() as f32 / f32::from(item.channels) / item.sample_rate as f32;
                println!(
                    "{:<26} {:<10} {} Гц, {} ch, {secs:.1} с",
                    item.name,
                    item.class.as_str(),
                    item.sample_rate,
                    item.channels
                );
            }
            Ok(())
        }
        Cmd::Run {
            bitrates,
            items,
            no_transients,
            no_vbr,
            json,
            label,
            baseline,
            wav_dir,
        } => {
            let all = corpus::full_corpus();
            let selected: Vec<_> = match &items {
                Some(names) => {
                    for n in names {
                        if !all.iter().any(|i| i.name == n) {
                            return Err(format!("неизвестный кейс: {n}").into());
                        }
                    }
                    all.into_iter()
                        .filter(|i| names.iter().any(|n| n == i.name))
                        .collect()
                }
                None => all,
            };
            let variant = EncoderVariant {
                transients: !no_transients,
                vbr: !no_vbr,
            };
            let results = runner::run_grid(&selected, bitrates.as_deref(), variant);
            print!("{}", report::table(&results));

            if let Some(dir) = &wav_dir {
                fs::create_dir_all(dir)?;
                for item in &selected {
                    write_wav(
                        &dir.join(format!("{}_ref.wav", item.name)),
                        &item.pcm,
                        item.sample_rate,
                        u16::from(item.channels),
                    )?;
                    let rates = bitrates
                        .as_deref()
                        .unwrap_or_else(|| runner::default_bitrates(item.channels));
                    for &r in rates {
                        let (decoded, _, _, _) = runner::transcode(item, r * 1000, variant);
                        write_wav(
                            &dir.join(format!("{}_{r}k.wav", item.name)),
                            &decoded,
                            item.sample_rate,
                            u16::from(item.channels),
                        )?;
                    }
                }
                println!("WAV записаны в {}", dir.display());
            }

            let snapshot = Snapshot::new(
                label.unwrap_or_else(|| format!("frc-a-polygon {}", env!("CARGO_PKG_VERSION"))),
                results,
            );
            if let Some(path) = &json {
                fs::write(path, serde_json::to_string_pretty(&snapshot)?)?;
                println!("снимок: {}", path.display());
            }
            if let Some(path) = &baseline {
                let old: Snapshot = serde_json::from_str(&fs::read_to_string(path)?)?;
                compare_snapshots(&old, &snapshot)?;
            }
            Ok(())
        }
        Cmd::Compare { old, new } => {
            let old: Snapshot = serde_json::from_str(&fs::read_to_string(old)?)?;
            let new: Snapshot = serde_json::from_str(&fs::read_to_string(new)?)?;
            compare_snapshots(&old, &new)
        }
    }
}

fn compare_snapshots(old: &Snapshot, new: &Snapshot) -> CliResult<()> {
    println!("\nдельты ({} → {}):", old.label, new.label);
    print!("{}", report::delta_table(old, new));
    let problems = report::regressions(old, new, Tolerance::default());
    if problems.is_empty() {
        println!("регрессий нет");
        Ok(())
    } else {
        for p in &problems {
            eprintln!("РЕГРЕССИЯ: {p}");
        }
        Err(format!("{} регрессий против baseline", problems.len()).into())
    }
}

fn write_wav(path: &Path, samples: &[f32], sample_rate: u32, channels: u16) -> CliResult<()> {
    let spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec)?;
    for &s in samples {
        writer.write_sample((s.clamp(-1.0, 1.0) * 32_767.0).round() as i16)?;
    }
    writer.finalize()?;
    Ok(())
}
