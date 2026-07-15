//! flora-diff — differential-инструмент (§7.3): replay GET-запросов на два апстрима
//! (.NET и Rust) с семантическим сравнением статусов и JSON-тел.
//!
//! Примеры:
//!   flora-diff --left http://127.0.0.1:5284 --right http://127.0.0.1:5290 --path /health --path /version
//!   flora-diff --left ... --right ... --paths-file paths.txt --header "Authorization: Bearer ..." --tolerance 1e-9
//!
//! Выход: 0 — расхождений нет; 1 — есть расхождения; 2 — ошибка выполнения.

use clap::Parser;
use flora_parity::semantic::{CompareOptions, diff};

#[derive(Parser)]
#[command(
    name = "flora-diff",
    about = "Семантический дифф ответов двух бэкендов Flora"
)]
struct Cli {
    /// Базовый URL эталона (обычно .NET).
    #[arg(long)]
    left: String,

    /// Базовый URL проверяемого (обычно Rust).
    #[arg(long)]
    right: String,

    /// Путь для сравнения (можно несколько раз).
    #[arg(long = "path")]
    paths: Vec<String>,

    /// Файл со списком путей (по одному в строке, `#` — комментарий).
    #[arg(long)]
    paths_file: Option<std::path::PathBuf>,

    /// Дополнительный заголовок "Имя: значение" (можно несколько раз).
    #[arg(long = "header")]
    headers: Vec<String>,

    /// Допуск для чисел с плавающей точкой (FIRA-скоринг), по умолчанию строгое равенство.
    #[arg(long, default_value_t = 0.0)]
    tolerance: f64,
}

#[tokio::main]
async fn main() {
    std::process::exit(match run().await {
        Ok(true) => 0,
        Ok(false) => 1,
        Err(error) => {
            eprintln!("flora-diff: ошибка: {error:#}");
            2
        }
    });
}

async fn run() -> anyhow::Result<bool> {
    let cli = Cli::parse();

    let mut paths = cli.paths.clone();
    if let Some(file) = &cli.paths_file {
        let text = std::fs::read_to_string(file)?;
        paths.extend(
            text.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .map(str::to_string),
        );
    }
    anyhow::ensure!(
        !paths.is_empty(),
        "не задано ни одного пути (--path/--paths-file)"
    );

    let mut header_map = reqwest::header::HeaderMap::new();
    for raw in &cli.headers {
        let (name, value) = raw
            .split_once(':')
            .ok_or_else(|| anyhow::anyhow!("заголовок не в формате 'Имя: значение': {raw}"))?;
        header_map.insert(
            reqwest::header::HeaderName::from_bytes(name.trim().as_bytes())?,
            value.trim().parse()?,
        );
    }

    let client = reqwest::Client::builder()
        .default_headers(header_map)
        .build()?;
    let options = CompareOptions {
        float_tolerance: cli.tolerance,
    };

    let mut all_equal = true;
    for path in &paths {
        match compare_path(&client, &cli.left, &cli.right, path, options).await {
            Ok(mismatches) if mismatches.is_empty() => println!("OK   {path}"),
            Ok(mismatches) => {
                all_equal = false;
                println!("DIFF {path} — {} расхождений:", mismatches.len());
                for m in mismatches.iter().take(20) {
                    println!("     {} — {}", m.path, m.reason);
                }
                if mismatches.len() > 20 {
                    println!("     … и ещё {}", mismatches.len() - 20);
                }
            }
            Err(error) => {
                all_equal = false;
                println!("ERR  {path} — {error:#}");
            }
        }
    }
    Ok(all_equal)
}

async fn compare_path(
    client: &reqwest::Client,
    left_base: &str,
    right_base: &str,
    path: &str,
    options: CompareOptions,
) -> anyhow::Result<Vec<flora_parity::semantic::Mismatch>> {
    let left = fetch(client, left_base, path).await?;
    let right = fetch(client, right_base, path).await?;

    let mut mismatches = Vec::new();
    if left.0 != right.0 {
        mismatches.push(flora_parity::semantic::Mismatch {
            path: "$status".into(),
            reason: format!("статусы различаются: {} vs {}", left.0, right.0),
        });
    }
    match (left.1, right.1) {
        (Some(l), Some(r)) => mismatches.extend(diff(&l, &r, options)),
        (None, None) => {}
        (l, r) => mismatches.push(flora_parity::semantic::Mismatch {
            path: "$body".into(),
            reason: format!(
                "один из ответов не JSON (left json: {}, right json: {})",
                l.is_some(),
                r.is_some(),
            ),
        }),
    }
    Ok(mismatches)
}

async fn fetch(
    client: &reqwest::Client,
    base: &str,
    path: &str,
) -> anyhow::Result<(u16, Option<serde_json::Value>)> {
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    let response = client.get(&url).send().await?;
    let status = response.status().as_u16();
    let bytes = response.bytes().await?;
    Ok((status, serde_json::from_slice(&bytes).ok()))
}
