//! Write-gate аккаунт-санкции: заблокированный аккаунт не выполняет мутации.
//!
//! Слой навешивается внутри роутера модуля. Копия живёт в каждом модуле, где есть
//! запись: подъём в `flora-shared` запрещён (`AGENTS.md` — бизнес-логика только
//! в модулях). Порт статуса — `AccountSanctionStatus` из `flora-users-contracts`.
//!
//! Отличие Messaging от Users: `/api/messaging/franking/**` из-под gate исключён.
//! Заблокированный аккаунт остаётся стороной разбирательства о себе (viewer-wrap,
//! claim/release/resolve по своим заявкам), иначе бан обрывает модерацию.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{Method, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use flora_users_contracts::AccountSanctionStatus;

use crate::http::{CurrentUser, internal};

/// Текст ответа заморожен: клиент разбирает его как есть.
pub(crate) const ACCOUNT_BLOCKED_MESSAGE: &str = "Аккаунт заблокирован.";

/// FSCP-FRANK висит на общем роутере модуля — исключение только по префиксу пути.
const FRANKING_PATH_PREFIX: &str = "/api/messaging/franking/";

/// Навешивает write-gate на готовый роутер модуля (после `with_state`).
pub(crate) fn write_gate(router: Router, status: Arc<dyn AccountSanctionStatus>) -> Router {
    router.layer(axum::middleware::from_fn_with_state(
        status,
        deny_blocked_writes,
    ))
}

fn is_franking_path(path: &str) -> bool {
    path.starts_with(FRANKING_PATH_PREFIX)
}

/// GET/HEAD/OPTIONS проходят всегда — заблокированный аккаунт продолжает читать.
/// Без `CurrentUser` проверять некого. Ошибка порта — fail closed (500),
/// молчаливого пропуска записи быть не должно.
async fn deny_blocked_writes(
    State(status): State<Arc<dyn AccountSanctionStatus>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let method = request.method();
    if *method == Method::GET || *method == Method::HEAD || *method == Method::OPTIONS {
        return next.run(request).await;
    }
    if is_franking_path(request.uri().path()) {
        return next.run(request).await;
    }
    let Some(user_uuid) = request.extensions().get::<CurrentUser>().map(|user| user.0) else {
        return next.run(request).await;
    };
    match status.is_blocked(user_uuid).await {
        Ok(false) => next.run(request).await,
        Ok(true) => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": ACCOUNT_BLOCKED_MESSAGE })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::routing::{get, post};
    use flora_users_contracts::BoxFuture;
    use http_body_util::BodyExt;
    use tower::util::ServiceExt;
    use uuid::Uuid;

    struct StubStatus(bool);

    impl AccountSanctionStatus for StubStatus {
        fn is_blocked(&self, _user_uuid: Uuid) -> BoxFuture<'_, Result<bool, String>> {
            Box::pin(async move { Ok(self.0) })
        }

        fn blocked_among(&self, _user_uuids: &[Uuid]) -> BoxFuture<'_, Result<Vec<Uuid>, String>> {
            Box::pin(async move { Ok(Vec::new()) })
        }
    }

    struct UnavailableStatus;

    impl AccountSanctionStatus for UnavailableStatus {
        fn is_blocked(&self, _user_uuid: Uuid) -> BoxFuture<'_, Result<bool, String>> {
            Box::pin(async move { Err("pool timed out".into()) })
        }

        fn blocked_among(&self, _user_uuids: &[Uuid]) -> BoxFuture<'_, Result<Vec<Uuid>, String>> {
            Box::pin(async move { Err("pool timed out".into()) })
        }
    }

    /// Формы маршрутов Messaging: чтение диалогов, отправка в DM и в группу,
    /// плюс franking-исключение (GET server-key и POST resolve).
    fn app(status: Arc<dyn AccountSanctionStatus>) -> Router {
        write_gate(
            Router::new()
                .route("/api/messaging/conversations", get(|| async { "list" }))
                .route(
                    "/api/messaging/conversations/{conversation_uuid}/messages",
                    get(|| async { "messages" }).post(|| async { "sent" }),
                )
                .route(
                    "/api/messaging/groups/{conversation_uuid}/messages",
                    post(|| async { "group sent" }),
                )
                .route(
                    "/api/messaging/e2e/key-backup",
                    axum::routing::put(|| async { "backup" }),
                )
                .route(
                    "/api/messaging/franking/server-key",
                    get(|| async { "server key" }),
                )
                .route(
                    "/api/messaging/franking/reports",
                    post(|| async { "reported" }),
                )
                .route(
                    "/api/messaging/franking/reports/{report_uuid}/resolve",
                    post(|| async { "resolved" }),
                ),
            status,
        )
    }

    async fn send(
        router: &Router,
        method: &str,
        uri: &str,
        caller: Option<Uuid>,
    ) -> (StatusCode, String) {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .body(Body::empty())
            .expect("request");
        if let Some(user_uuid) = caller {
            request.extensions_mut().insert(CurrentUser(user_uuid));
        }
        let response = router.clone().oneshot(request).await.expect("response");
        let status = response.status();
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        (status, String::from_utf8(bytes.to_vec()).expect("utf8"))
    }

    #[tokio::test]
    async fn blocked_caller_is_denied_writes_but_keeps_reads() {
        let router = app(Arc::new(StubStatus(true)));
        let caller = Some(Uuid::now_v7());
        let conversation = Uuid::now_v7();

        let (status, body) = send(
            &router,
            "POST",
            &format!("/api/messaging/conversations/{conversation}/messages"),
            caller,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body, r#"{"error":"Аккаунт заблокирован."}"#);

        let (status, body) = send(
            &router,
            "POST",
            &format!("/api/messaging/groups/{conversation}/messages"),
            caller,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body, r#"{"error":"Аккаунт заблокирован."}"#);

        let (status, _) = send(&router, "PUT", "/api/messaging/e2e/key-backup", caller).await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, body) = send(&router, "GET", "/api/messaging/conversations", caller).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "list");

        let (status, _) = send(
            &router,
            "GET",
            &format!("/api/messaging/conversations/{conversation}/messages"),
            caller,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    /// Бан не должен обрывать разбирательство о самом забаненном.
    #[tokio::test]
    async fn blocked_caller_still_reaches_franking_routes() {
        let router = app(Arc::new(StubStatus(true)));
        let caller = Some(Uuid::now_v7());
        let report = Uuid::now_v7();

        let (status, body) = send(&router, "POST", "/api/messaging/franking/reports", caller).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "reported");

        let (status, body) = send(
            &router,
            "POST",
            &format!("/api/messaging/franking/reports/{report}/resolve"),
            caller,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "resolved");

        let (status, _) = send(&router, "GET", "/api/messaging/franking/server-key", caller).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn unblocked_caller_writes_normally() {
        let router = app(Arc::new(StubStatus(false)));
        let caller = Some(Uuid::now_v7());
        let conversation = Uuid::now_v7();

        let (status, body) = send(
            &router,
            "POST",
            &format!("/api/messaging/conversations/{conversation}/messages"),
            caller,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "sent");
    }

    #[tokio::test]
    async fn request_without_current_user_passes_through() {
        let router = app(Arc::new(StubStatus(true)));
        let conversation = Uuid::now_v7();

        let (status, body) = send(
            &router,
            "POST",
            &format!("/api/messaging/conversations/{conversation}/messages"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "sent");
    }

    #[tokio::test]
    async fn status_error_fails_closed() {
        let router = app(Arc::new(UnavailableStatus));
        let caller = Some(Uuid::now_v7());
        let conversation = Uuid::now_v7();

        let (status, _) = send(
            &router,
            "POST",
            &format!("/api/messaging/conversations/{conversation}/messages"),
            caller,
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);

        let (status, _) = send(&router, "GET", "/api/messaging/conversations", caller).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[test]
    fn franking_prefix_matches_only_franking_routes() {
        assert!(is_franking_path("/api/messaging/franking/reports"));
        assert!(is_franking_path(
            "/api/messaging/franking/reports/019e/resolve"
        ));
        assert!(!is_franking_path("/api/messaging/conversations"));
        assert!(!is_franking_path("/api/messaging/frankingx/reports"));
        assert!(!is_franking_path("/api/auth/messages"));
    }
}
