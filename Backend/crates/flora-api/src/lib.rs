//! Хост Flora (порт `Flora.API`): конфиг, tracing, нативные маршруты, gateway-fallback.
//! Бизнес-логика запрещена (AGENTS.md) — только маршрутизация, middleware и композиция.
//!
//! Библиотечная часть существует ради интеграционных тестов; исполняемая точка — `main.rs`.

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

/// Собирает полный роутер хоста: нативные маршруты (+ product-роутер flora-social)
/// под сквозными middleware §4.7 и fallback-прокси на .NET для всего остального.
///
/// Для проксируемых маршрутов сквозные middleware остаются на стороне .NET (§5.1),
/// поэтому CORS и проверка версии клиента навешиваются только на нативную часть.
pub fn build_router(cfg: &FloraConfig, versions: versions::FloraVersionResponse) -> Router {
    let mut native = routes::host_router(versions)
        .merge(flora_social::product_router(cfg))
        .layer(axum::middleware::from_fn_with_state(
            client_version::MinClientVersion::from_config(cfg),
            client_version::enforce_min_client_version,
        ));

    if let Some(cors) = cors_layer(cfg) {
        native = native.layer(cors);
    }

    let routed = match proxy::DotnetUpstream::from_config(cfg) {
        Some(upstream) => native.fallback_service(proxy::proxy_service(upstream)),
        // Без апстрима (юнит-тесты, будущая Фаза 5) непойманные маршруты дают axum-404.
        None => native,
    };
    routed.layer(axum::middleware::from_fn(access_log::access_log))
}

/// CORS-политика `FloraWeb` (порт `Flora.API/Program.cs`): точные origins из конфига,
/// credentials, любые заголовки и методы (mirror — эквивалент AllowAnyHeader/AnyMethod
/// при включённых credentials).
fn cors_layer(cfg: &FloraConfig) -> Option<CorsLayer> {
    let origins = cfg.get_string_array("FloraWeb:CorsOrigins");
    if origins.is_empty() {
        return None;
    }
    let parsed: Vec<http::HeaderValue> = origins
        .iter()
        .filter_map(|o| o.parse().ok())
        .collect();
    Some(
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(parsed))
            .allow_methods(AllowMethods::mirror_request())
            .allow_headers(AllowHeaders::mirror_request())
            .allow_credentials(true),
    )
}

/// Адрес прослушивания хоста: `Gateway:Listen`, по умолчанию локальный порт 5290
/// (рядом с 5284 у .NET — nginx смотрит на этот порт с Фазы 0).
pub fn listen_addr(cfg: &FloraConfig) -> anyhow::Result<SocketAddr> {
    let raw = cfg.get_non_empty("Gateway:Listen").unwrap_or("127.0.0.1:5290");
    raw.parse()
        .map_err(|e| anyhow::anyhow!("Gateway:Listen '{raw}' не является адресом host:port: {e}"))
}
