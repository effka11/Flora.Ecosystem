//! CLI семейства Flora Media Codecs.
//!
//! Субкоманды сгруппированы по типу медиа: `image` — FIC (этот инструмент),
//! `video`/`audio` — добавляются агентами FVC/FAC отдельными модулями
//! (`video_cmd.rs`, `audio_cmd.rs`) без пересечения по файлам.

mod image_cmd;

use clap::{Parser, Subcommand};
use std::process::ExitCode;

#[derive(Parser)]
#[command(name = "flora-codec", about = "Инструменты кодеков FMC (Flora Media Codecs)")]
struct Cli {
    #[command(subcommand)]
    cmd: TopCommand,
}

#[derive(Subcommand)]
enum TopCommand {
    /// Фото-кодек FIC (Flora Image Codec)
    #[command(subcommand)]
    Image(image_cmd::ImageCommand),
}

fn main() -> ExitCode {
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
