//! Нативные маршруты хоста: `/`, `/health`, `/version` — паритет с `Flora.API/Program.cs`,
//! формы ответов зафиксированы фикстурами `Artifacts/contract-fixtures/api-*.json`.

use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;

use crate::versions::FloraVersionResponse;

pub fn host_router(versions: FloraVersionResponse) -> Router {
    Router::new()
        .route(
            "/",
            get(|| async { Json(json!({ "service": "Flora.API", "status": "ready" })) }),
        )
        .route(
            "/health",
            get(|| async { Json(json!({ "status": "healthy" })) }),
        )
        .route("/version", get(move || async move { Json(versions) }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http::{Request, StatusCode};
    use tower::util::ServiceExt;

    async fn get_json(router: Router, path: &str) -> (StatusCode, serde_json::Value) {
        let response = router
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    fn sample_versions() -> FloraVersionResponse {
        FloraVersionResponse::build(None, None)
    }

    #[tokio::test]
    async fn root_returns_ready() {
        let (status, body) = get_json(host_router(sample_versions()), "/").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "service": "Flora.API", "status": "ready" }));
    }

    #[tokio::test]
    async fn health_returns_healthy() {
        let (status, body) = get_json(host_router(sample_versions()), "/health").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "status": "healthy" }));
    }

    #[tokio::test]
    async fn version_returns_manifest_shape() {
        let (status, body) = get_json(host_router(sample_versions()), "/version").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["api"], env!("CARGO_PKG_VERSION"));
        assert!(
            body.as_object().unwrap().contains_key("commit"),
            "commit обязан присутствовать"
        );
    }

    #[tokio::test]
    async fn post_to_get_route_is_405_like_dotnet() {
        let response = host_router(sample_versions())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }
}
