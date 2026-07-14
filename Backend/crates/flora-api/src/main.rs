//! Точка входа Rust-хоста Flora. С Фазы 0 — единая точка входа за nginx:
//! нативно отвечает на `/`, `/health`, `/version`, остальное прозрачно проксирует
//! в .NET (next-architecture.md §5.1). Откат — флип nginx обратно на .NET.

use std::net::SocketAddr;
use std::time::Duration;

use flora_api::{build_router, listen_addr, versions::FloraVersionResponse};

fn main() -> anyhow::Result<()> {
    init_tracing();

    let cfg = flora_api::host_config::load_host_config()?;
    let versions = FloraVersionResponse::from_process_env();
    let addr = listen_addr(&cfg)?;
    let upstream_configured = cfg.get_non_empty("Gateway:DotnetUpstream").is_some();

    tracing::info!(
        environment = cfg.environment(),
        listen = %addr,
        gateway_fallback = upstream_configured,
        version = env!("CARGO_PKG_VERSION"),
        "flora-api запускается",
    );
    if !upstream_configured {
        tracing::warn!(
            "Gateway:DotnetUpstream не задан — непойманные маршруты будут отвечать 404 \
             (до Фазы 5 в проде это ошибка конфигурации)",
        );
    }

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(async {
            let router = build_router(&cfg, versions).await;
            serve(addr, router).await
        })
}

async fn serve(addr: SocketAddr, router: axum::Router) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(listen = %addr, "flora-api принимает подключения");

    // ConnectInfo нужен прокси для дописывания X-Forwarded-For (§5.1).
    let app = router.into_make_service_with_connect_info::<SocketAddr>();
    let server = axum::serve(listener, app).with_graceful_shutdown(shutdown_signal());

    // Долгоживущие SSE-стримы не завершатся сами: после сигнала даём 15 секунд
    // на дренаж и выходим (systemd добьёт при необходимости).
    tokio::select! {
        result = server => result.map_err(Into::into),
        () = async {
            shutdown_signal().await;
            tokio::time::sleep(Duration::from_secs(15)).await;
        } => {
            tracing::warn!("graceful shutdown не уложился в 15 с — принудительный выход");
            Ok(())
        }
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("установка обработчика Ctrl+C");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("установка обработчика SIGTERM")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!("получен сигнал завершения — дренаж подключений");
}

/// tracing: JSON-формат вне Development (совместимо с анализом логов на VPS, §8),
/// человекочитаемый — в Development. Уровни — через RUST_LOG (default info).
fn init_tracing() {
    use tracing_subscriber::EnvFilter;

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let development = flora_shared::config::environment_name()
        .eq_ignore_ascii_case(flora_shared::config::DEVELOPMENT);

    if development {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    } else {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .json()
            .init();
    }
}
