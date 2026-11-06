//! CLI семейства Flora Media Codecs.
//!
//! Субкоманды сгруппированы по типу медиа: `image` — FRC-I (этот инструмент),
//! `video`/`audio` — добавляются агентами FRC-V/FRC-A отдельными модулями
//! (`video_cmd.rs`, `audio_cmd.rs`) без пересечения по файлам.

mod image_cmd;

use clap::{Parser, Subcommand};
use std::process::ExitCode;

#[derive(Parser)]
#[command(
    name = "flora-codec",
    about = "Инструменты кодеков FRC (Flora Reproducible Codec)"
)]
struct Cli {
    #[command(subcommand)]
    cmd: TopCommand,
}

#[derive(Subcommand)]
enum TopCommand {
    /// Фото-кодек FRC-I (Flora Reproducible Codec — Image)
    #[command(subcommand)]
    Image(image_cmd::ImageCommand),
}

fn main() -> ExitCode {
    if let Err(err) = check_tuning_env() {
        eprintln!("ошибка: {err}");
        return ExitCode::FAILURE;
    }
    let cli = Cli::parse();
    let result = match cli.cmd {
        TopCommand::Image(cmd) => image_cmd::run(cmd),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("ошибка: {err}");
            ExitCode::FAILURE
        }
    }
}

/// Под feature `tuning-env` любая переменная `FRC_I_*`, которой нет
/// в реестре слоя ручек, — ошибка запуска: опечатка иначе молча
/// измеряла бы нейтраль (frc-i-v14-plan.md §4.3).
#[cfg(feature = "tuning-env")]
fn check_tuning_env() -> Result<(), String> {
    let known: std::collections::BTreeSet<&str> = frc_i::tuning_env_registry()
        .iter()
        .copied()
        .chain(["FRC_I_UPDATE_GOLDEN", "FRC_I_SEED_V2_GOLDEN"])
        .collect();
    let mut unknown: Vec<String> = std::env::vars_os()
        .filter_map(|(key, _)| key.into_string().ok())
        .filter(|key| key.starts_with("FRC_I_") && !known.contains(key.as_str()))
        .collect();
    unknown.sort();
    match unknown.split_first() {
        None => Ok(()),
        Some((first, rest)) => Err(match rest {
            [] => format!("неизвестная переменная окружения FRC_I: {first}"),
            _ => format!(
                "неизвестные переменные окружения FRC_I: {} и ещё {}",
                first,
                rest.len()
            ),
        }),
    }
}

#[cfg(not(feature = "tuning-env"))]
fn check_tuning_env() -> Result<(), String> {
    Ok(())
}
