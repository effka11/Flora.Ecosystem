//! Access-лог шлюза — главный дашборд миграции (§8): латентность per-route,
//! доля проксируемого трафика (`upstream=dotnet|native`), статусы.
//!
//! Латентность меряется до готовности заголовков ответа (TTFB): тела стримятся
//! и не должны буферизоваться ради метрики.

use std::time::Instant;

use axum::body::Body;
use axum::middleware::Next;
use axum::response::Response;

/// Маркер ответа, пришедшего из gateway-fallback (ставит прокси).
#[derive(Debug, Clone, Copy)]
pub struct ProxiedToDotnet;

pub async fn access_log(request: http::Request<Body>, next: Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let started = Instant::now();

    let response = next.run(request).await;

    let upstream = if response.extensions().get::<ProxiedToDotnet>().is_some() {
        "dotnet"
    } else {
        "native"
    };
    tracing::info!(
        target: "flora_api::access",
        %method,
        path,
        status = response.status().as_u16(),
        upstream,
        ttfb_ms = started.elapsed().as_millis() as u64,
        "request",
    );
    response
}
