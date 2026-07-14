//! Хост Flora (порт `Flora.API`): конфиг, tracing, нативные маршруты, gateway-fallback.
//! Бизнес-логика запрещена (AGENTS.md) — только маршрутизация, middleware и композиция.

pub mod access_log;
pub mod client_version;
pub mod host_config;
pub mod proxy;
pub mod routes;
pub mod versions;

use std::net::SocketAddr;

use axum::Router;
use flora_shared::config::FloraConfig;
use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer};

/// Собирает полный роутер хоста. При `Music:ServeNative` поднимает PgPool.
pub async fn build_router(cfg: &FloraConfig, versions: versions::FloraVersionResponse) -> Router {
    let pool = if flora_social::music_needs_pool(cfg) {
        match flora_social::connect_pool(cfg).await {
            Ok(pool) => Some(pool),
            Err(e) => {
                eprintln!("flora-api: не удалось открыть PgPool для Music:ServeNative: {e}");
                None
            }
        }
    } else {
        None
    };

    let mut native = routes::host_router(versions)
        .merge(flora_social::product_router(cfg, pool))
        .layer(axum::middleware::from_fn_with_state(
            client_version::MinClientVersion::from_config(cfg),
            client_version::enforce_min_client_version,
        ));

    if let Some(cors) = cors_layer(cfg) {
        native = native.layer(cors);
    }

    let routed = match proxy::DotnetUpstream::from_config(cfg) {
        Some(upstream) => native.fallback_service(proxy::proxy_service(upstream)),
        None => native,
    };
    routed.layer(axum::middleware::from_fn(access_log::access_log))
}

fn cors_layer(cfg: &FloraConfig) -> Option<CorsLayer> {
    let origins = cfg.get_string_array("FloraWeb:CorsOrigins");
    if origins.is_empty() {
        return None;
    }
    let parsed: Vec<http::HeaderValue> = origins.iter().filter_map(|o| o.parse().ok()).collect();
    Some(
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(parsed))
            .allow_methods(AllowMethods::mirror_request())
            .allow_headers(AllowHeaders::mirror_request())
            .allow_credentials(true),
    )
}

pub fn listen_addr(cfg: &FloraConfig) -> anyhow::Result<SocketAddr> {
    let raw = cfg
        .get_non_empty("Gateway:Listen")
        .unwrap_or("127.0.0.1:5290");
    raw.parse()
        .map_err(|e| anyhow::anyhow!("Gateway:Listen '{raw}' не является адресом host:port: {e}"))
}
