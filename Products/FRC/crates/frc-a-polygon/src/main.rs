//! CLI полигона FRC-A: прогон корпуса, арена против внешних кодеков,
//! JSON-снимки, сравнение с baseline, экспорт WAV для прослушивания.

use std::fs;
use std::path::{Path, PathBuf};

use clap::{Parser, Subcommand};
use frc_a_polygon::corpus;
use frc_a_polygon::external::{self, ExtCodec};
use frc_a_polygon::report::{self, Snapshot, Tolerance};
use frc_a_polygon::runner::{self, EncoderVariant};

type CliResult<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Parser)]
#[command(
    name = "frc-a-polygon",
    version,
    about = "Полигон качества FRC-A: корпус, метрики, регрессии, арена против Opus/AAC/MP3/Vorbis"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Перечислить кейсы корпуса
    List,
    /// Показать доступность ffmpeg и кодеков арены
    Probe,
    /// Прогнать корпус и напечатать таблицу метрик
    Run {
        /// Битрейты (kbps) через запятую вместо сетки по умолчанию
        #[arg(long, value_delimiter = ',')]
        bitrates: Option<Vec<u32>>,
        /// Ограничить прогон кейсами (имена через запятую)
        #[arg(long, value_delimiter = ',')]
        items: Option<Vec<String>>,
        /// Арена: конкуренты через запятую (opus,aac,mp3,vorbis) или all
        #[arg(long, value_delimiter = ',')]
        vs: Option<Vec<String>>,
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
        /// Каталог для WAV (эталон + декоды всех кодеков) — прослушивание
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
        Cmd::Probe => {
            match external::info() {
                None => println!(
                    "ffmpeg/ffprobe не найдены в PATH — арена недоступна, полигон работает в режиме только-FRC-A"
                ),
                Some(ff) => {
                    println!("{}", ff.version);
                    let avail = external::available();
                    for c in ExtCodec::ALL {
                        if avail.contains(&c) {
                            println!("{:<7} доступен", c.id());
                        } else {
                            println!("{:<7} НЕТ (нет энкодера в этой сборке ffmpeg)", c.id());
                        }
                    }
                }
            }
            Ok(())
        }
        Cmd::Run {
            bitrates,
            items,
            vs,
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
            let competitors = parse_competitors(vs.as_deref())?;

            let (results, warnings) = runner::run_arena(
                &selected,
                bitrates.as_deref(),
                variant,
                &competitors,
                !competitors.is_empty(),
            );
            print!("{}", report::table(&results));
            print!("{}", report::arena_summary(&results));
            for w in &warnings {
                eprintln!("предупреждение: {w}");
            }

            if let Some(dir) = &wav_dir {
                export_wavs(dir, &selected, bitrates.as_deref(), variant, &competitors)?;
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

/// Разбор `--vs`: имена кодеков или `all` (все доступные). Явно названный
/// недоступный кодек — ошибка; `all` при отсутствии ffmpeg — предупреждение.
fn parse_competitors(vs: Option<&[String]>) -> CliResult<Vec<ExtCodec>> {
    let Some(tokens) = vs else {
        return Ok(Vec::new());
    };
    let available = external::available();
    let mut list: Vec<ExtCodec> = Vec::new();
    for t in tokens {
        if t.eq_ignore_ascii_case("all") {
            if available.is_empty() {
                eprintln!("предупреждение: ffmpeg недоступен — арена пропущена, только frc-a");
            }
            for c in &available {
                if !list.contains(c) {
                    list.push(*c);
                }
            }
            continue;
        }
        let c = ExtCodec::parse(t)
            .ok_or_else(|| format!("неизвестный кодек арены: {t} (opus|aac|mp3|vorbis|all)"))?;
        if !available.contains(&c) {
            return Err(format!(
                "кодек {} недоступен: {}",
                c.id(),
                if external::info().is_none() {
                    "ffmpeg/ffprobe не найдены в PATH"
                } else {
                    "в сборке ffmpeg нет нужного энкодера"
                }
            )
            .into());
        }
        if !list.contains(&c) {
            list.push(c);
        }
    }
    Ok(list)
}

/// Экспорт WAV: эталон + декоды FRC-A и конкурентов по всей сетке.
fn export_wavs(
    dir: &Path,
    items: &[corpus::CorpusItem],
    bitrates: Option<&[u32]>,
    variant: EncoderVariant,
    competitors: &[ExtCodec],
) -> CliResult<()> {
    fs::create_dir_all(dir)?;
    for item in items {
        write_wav(
            &dir.join(format!("{}_ref.wav", item.name)),
            &item.pcm,
            item.sample_rate,
            u16::from(item.channels),
        )?;
        let rates = bitrates.unwrap_or_else(|| runner::default_bitrates(item.channels));
        for &r in rates {
            let (decoded, _, _, _) = runner::transcode(item, r * 1000, variant);
            write_wav(
                &dir.join(format!("{}_frc-a_{r}k.wav", item.name)),
                &decoded,
                item.sample_rate,
                u16::from(item.channels),
            )?;
            for &c in competitors {
                match external::transcode(item, r, c) {
                    Ok(ext) => write_wav(
                        &dir.join(format!("{}_{}_{r}k.wav", item.name, c.id())),
                        &ext.aligned,
                        item.sample_rate,
                        u16::from(item.channels),
                    )?,
                    Err(e) => eprintln!("wav {} {} @{r}k: {e}", c.id(), item.name),
                }
            }
        }
    }
    println!("WAV записаны в {}", dir.display());
    Ok(())
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
