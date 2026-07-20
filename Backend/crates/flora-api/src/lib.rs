//! Хост Flora (порт `Flora.API`): конфиг, tracing, нативные маршруты, gateway-fallback.
//! Бизнес-логика запрещена (AGENTS.md) — только маршрутизация, middleware и композиция.

pub mod access_log;
pub mod client_ip;
pub mod client_version;
pub mod host_config;
pub mod proxy;
pub mod routes;
pub mod versions;

use std::net::SocketAddr;

use axum::Router;
use flora_shared::config::FloraConfig;
use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer};

/// Собирает хост: роутер + фоновые задачи (Music workers, Verification gRPC).
pub struct BuiltHost {
    pub router: Router,
    pub worker_handles: Vec<flora_social::BackgroundHandle>,
}

/// Собирает полный роутер хоста. PgPool — при Music/Auth ServeNative и/или Verification gRPC.
pub async fn build_host(cfg: &FloraConfig, versions: versions::FloraVersionResponse) -> BuiltHost {
    let pool = if flora_social::host_needs_pool(cfg) {
        match flora_social::connect_pool(cfg).await {
            Ok(pool) => Some(pool),
            Err(e) => {
                eprintln!("flora-api: не удалось открыть PgPool для native-модулей: {e}");
                None
            }
        }
    } else {
        None
    };

    let product = flora_social::compose_product(cfg, pool);
    let worker_handles = product.background;

    let mut native = routes::host_router(versions).merge(product.router).layer(
        axum::middleware::from_fn_with_state(
            client_version::MinClientVersion::from_config(cfg),
            client_version::enforce_min_client_version,
        ),
    );

    if let Some(cors) = cors_layer(cfg) {
        native = native.layer(cors);
    }

    let routed = match proxy::DotnetUpstream::from_config(cfg) {
        Some(upstream) => native.fallback_service(proxy::proxy_service(upstream)),
        None => native,
    };
    let client_ip_resolver = client_ip::ClientIpResolver::from_config(cfg);
    BuiltHost {
        router: routed
            .layer(axum::middleware::from_fn_with_state(
                client_ip_resolver,
                client_ip::normalize_client_ip,
            ))
            .layer(axum::middleware::from_fn(access_log::access_log)),
        worker_handles,
    }
}

/// Обратная совместимость тестов/вызовов без workers.
pub async fn build_router(cfg: &FloraConfig, versions: versions::FloraVersionResponse) -> Router {
    build_host(cfg, versions).await.router
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
