//! Паритет нативных маршрутов с C#-фикстурами `artifacts/contract-fixtures/api-*.json`
//! (захвачены с работающего Flora.API — см. HostEndpointFixtureTests.cs).

use axum::body::Body;
use flora_api::versions::FloraVersionResponse;
use flora_shared::config::FloraConfig;
use http::Request;
use tower::util::ServiceExt;

fn repo_root() -> std::path::PathBuf {
    // Backend/crates/flora-api → корень репозитория.
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .canonicalize()
        .expect("корень репозитория")
}

fn load_fixture(name: &str) -> serde_json::Value {
    let path = repo_root()
        .join("artifacts")
        .join("contract-fixtures")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("фикстура {} недоступна: {e}", path.display()));
    serde_json::from_str(&text).expect("фикстура должна быть валидным JSON")
}

/// Роутер без fallback-прокси (Gateway:DotnetUpstream не задан) — нативная поверхность.
fn native_router() -> axum::Router {
    let manifest = repo_root().join("VERSION");
    let versions = FloraVersionResponse::build(Some(&manifest), None);
    flora_api::build_router(&FloraConfig::default(), versions)
}

async fn get_json(path: &str) -> serde_json::Value {
    let response = native_router()
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), http::StatusCode::OK, "GET {path}");
    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn root_matches_csharp_fixture() {
    assert_eq!(get_json("/").await, load_fixture("api-root.json"));
}

#[tokio::test]
async fn health_matches_csharp_fixture() {
    assert_eq!(get_json("/health").await, load_fixture("api-health.json"));
}

#[tokio::test]
async fn version_matches_csharp_fixture() {
    // Полное совпадение с C#: ecosystem/products из манифеста, api — версия сборки
    // (синхронизирована с VERSION через sync-version.mjs), commit — explicit null.
    assert_eq!(get_json("/version").await, load_fixture("api-version.json"));
}

#[tokio::test]
async fn unmatched_route_is_404_without_upstream() {
    let response = native_router()
        .oneshot(
            Request::builder()
                .uri("/api/anything")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), http::StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn outdated_client_gets_426_on_native_route() {
    let cfg = FloraConfig::from_layers(
        "Production",
        &[serde_json::json!({ "FloraMobile": { "MinClientVersion": "1.2.0" } })],
        &[],
    );
    let router = flora_api::build_router(&cfg, FloraVersionResponse::build(None, None));
    let response = router
        .oneshot(
            Request::builder()
                .uri("/version")
                .header("X-Flora-Client", "android/1.0.0")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), http::StatusCode::UPGRADE_REQUIRED);
    let bytes = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["minClientVersion"], "1.2.0");
}

#[tokio::test]
async fn cors_preflight_allows_configured_origin_with_credentials() {
    let cfg = FloraConfig::from_layers(
        "Production",
        &[serde_json::json!({ "FloraWeb": { "CorsOrigins": ["http://localhost:3000"] } })],
        &[],
    );
    let router = flora_api::build_router(&cfg, FloraVersionResponse::build(None, None));
    let response = router
        .oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/health")
                .header("Origin", "http://localhost:3000")
                .header("Access-Control-Request-Method", "GET")
                .header("Access-Control-Request-Headers", "authorization")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let headers = response.headers();
    assert_eq!(
        headers
            .get("access-control-allow-origin")
            .and_then(|v| v.to_str().ok()),
        Some("http://localhost:3000"),
    );
    assert_eq!(
        headers
            .get("access-control-allow-credentials")
            .and_then(|v| v.to_str().ok()),
        Some("true"),
    );
}
