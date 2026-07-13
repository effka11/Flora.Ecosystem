//! flora-migrate — применение миграций всех модулей (замена `Flora.Migrations` по мере фаз).
//!
//! Использование:
//!   flora-migrate --dry-run                # план без подключения к БД
//!   flora-migrate                          # применить (строка подключения из конфига §4.8)
//!   flora-migrate --connection "Host=..."  # явная строка (формат Npgsql, как у .NET)

mod registry;

use clap::Parser;
use flora_shared::npgsql::NpgsqlConnectionString;

#[derive(Parser)]
#[command(
    name = "flora-migrate",
    about = "Миграции модулей Flora: sqlx migrate, история на модуль (__flora_migrations_<module>)"
)]
struct Cli {
    /// Показать план, не подключаясь к БД.
    #[arg(long)]
    dry_run: bool,

    /// Строка подключения в формате Npgsql; по умолчанию — ConnectionStrings:FloraDatabase из конфига.
    #[arg(long)]
    connection: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();
    let modules = registry::registry();

    let pending: Vec<&registry::ModuleMigrations> =
        modules.iter().filter(|m| m.migrator.is_some()).collect();

    for module in &modules {
        match module.migrator {
            Some(_) => tracing::info!(
                module = module.module,
                history_table = module.history_table(),
                "модуль с Rust-миграциями",
            ),
            None => tracing::info!(
                module = module.module,
                owner = module.current_owner,
                "миграциями владеет C#/EF — пропуск (next-architecture.md §5.3)",
            ),
        }
    }

    if pending.is_empty() {
        tracing::info!("Rust-миграций нет: схема модулей заморожена до их cutover. Готово.");
        return Ok(());
    }

    if cli.dry_run {
        tracing::info!(modules = pending.len(), "dry-run: применение пропущено");
        return Ok(());
    }

    let raw_connection = match cli.connection {
        Some(c) => c,
        None => {
            let cfg = flora_shared::config::FloraConfig::load(
                &flora_shared::config::environment_name(),
                &std::env::current_dir()?,
            )?;
            cfg.get_non_empty("ConnectionStrings:FloraDatabase")
                .ok_or_else(|| anyhow::anyhow!("ConnectionStrings:FloraDatabase не задана"))?
                .to_string()
        }
    };

    let pool = connect(&raw_connection).await?;
    for module in pending {
        apply_module(&pool, module).await?;
    }
    Ok(())
}

async fn connect(raw: &str) -> anyhow::Result<sqlx::PgPool> {
    let parsed = NpgsqlConnectionString::parse(raw)
        .map_err(|e| anyhow::anyhow!("строка подключения (формат Npgsql): {e}"))?;

    let mut options = sqlx::postgres::PgConnectOptions::new()
        .host(parsed.host.as_deref().unwrap_or("localhost"))
        .port(parsed.port.unwrap_or(5432));
    if let Some(database) = &parsed.database {
        options = options.database(database);
    }
    if let Some(username) = &parsed.username {
        options = options.username(username);
    }
    if let Some(password) = &parsed.password {
        options = options.password(password);
    }
    if let Some(ssl_mode) = &parsed.ssl_mode {
        options = options.ssl_mode(match ssl_mode.to_lowercase().as_str() {
            "disable" => sqlx::postgres::PgSslMode::Disable,
            "require" => sqlx::postgres::PgSslMode::Require,
            "allow" => sqlx::postgres::PgSslMode::Allow,
            _ => sqlx::postgres::PgSslMode::Prefer,
        });
    }
    if let Some(search_path) = &parsed.search_path {
        options = options.options([("search_path", search_path.as_str())]);
    }

    Ok(sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?)
}

async fn apply_module(
    pool: &sqlx::PgPool,
    module: &registry::ModuleMigrations,
) -> anyhow::Result<()> {
    let Some(migrator) = module.migrator else { return Ok(()) };
    // Отдельная таблица истории на модуль — инвариант §3 (как __EFMigrationsHistory_*).
    let mut migrator = migrator.clone();
    migrator.dangerous_set_table_name(module.history_table());
    tracing::info!(module = module.module, "применение миграций");
    migrator.run(pool).await?;
    Ok(())
}
