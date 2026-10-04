//! HTTP Notifications — inbox + push-token + SSE + admin broadcast (`Notifications:ServeNative`).

mod account_block;

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Json;
use axum::Router;
use axum::extract::{Extension, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use flora_users_contracts::AccountSanctionStatus;
use futures_util::StreamExt;
use serde::Deserialize;
use subtle::ConstantTimeEq;
use uuid::Uuid;

use flora_notifications_contracts::AppUpdatePayload;

use crate::application::{
    InboxService, PushTokenService, SecurePreviewRegistration, client_platform_from_header,
};
use crate::infrastructure::UserRealtimeHub;

/// JWT user (тот же тип, что внедряет flora-social).
#[derive(Clone, Copy, Debug)]
pub struct CurrentUser(pub Uuid);

#[derive(Clone)]
pub struct NotificationsState {
    pub inbox: Arc<InboxService>,
    pub push_tokens: Arc<PushTokenService>,
    pub hub: Arc<UserRealtimeHub>,
}

#[derive(Clone)]
pub struct AdminBroadcastState {
    pub inbox: Arc<InboxService>,
    /// `Flora:AdminBroadcastToken` after trim; `None` → endpoint disabled (404).
    pub admin_token: Option<Arc<str>>,
    pub rate_limiter: Arc<AdminBroadcastRateLimiter>,
}

pub struct AdminBroadcastRateLimiter {
    state: Mutex<AdminLimiterState>,
}

struct AdminLimiterState {
    buckets: HashMap<String, (Instant, u32)>,
    last_cleanup: Instant,
}

impl AdminBroadcastRateLimiter {
    const PERMIT_LIMIT: u32 = 10;
    const WINDOW: Duration = Duration::from_secs(15 * 60);
    const MAX_BUCKETS: usize = 10_000;

    pub fn new() -> Self {
        Self::default()
    }

    fn check_and_increment(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut state = self.state.lock().expect("admin rate limiter lock");
        if now.duration_since(state.last_cleanup) >= Duration::from_secs(30) {
            state
                .buckets
                .retain(|_, (start, _)| now.duration_since(*start) < Self::WINDOW);
            state.last_cleanup = now;
        }
        if !state.buckets.contains_key(key) && state.buckets.len() >= Self::MAX_BUCKETS {
            return false;
        }
        let entry = state.buckets.entry(key.to_string()).or_insert((now, 0));
        if entry.1 >= Self::PERMIT_LIMIT {
            return false;
        }
        entry.1 += 1;
        true
    }
}

impl Default for AdminBroadcastRateLimiter {
    fn default() -> Self {
        Self {
            state: Mutex::new(AdminLimiterState {
                buckets: HashMap::new(),
                last_cleanup: Instant::now(),
            }),
        }
    }
}

pub fn protected_router(
    state: NotificationsState,
    account_status: Arc<dyn AccountSanctionStatus>,
) -> Router {
    let router = Router::new()
        .route(
            "/api/auth/notifications",
            get(list_notifications).delete(delete_notifications),
        )
        .route("/api/auth/notifications/unread-count", get(unread_count))
        .route("/api/auth/notifications/read", post(mark_all_read))
        .route("/api/auth/notifications/all", delete(delete_all))
        .route(
            "/api/auth/notifications/{notification_uuid}/read",
            patch(mark_read),
        )
        .route(
            "/api/auth/push-token",
            axum::routing::put(register_push_token)
                .post(register_push_token)
                .delete(unregister_push_token),
        )
        .route("/api/auth/signals/stream", get(signals_stream))
        .with_state(state);
    // Write-gate после with_state: JWT-слой flora-social снаружи, Extension<CurrentUser> уже есть.
    // Admin broadcast — без CurrentUser; gate на admin_router не вешаем.
    account_block::write_gate(router, account_status)
}

/// Admin broadcast — NO JWT; auth via `X-Flora-Admin-Token`.
pub fn admin_router(state: AdminBroadcastState) -> Router {
    Router::new()
        .route(
            "/api/admin/notifications/broadcast",
            post(broadcast_notification),
        )
        .with_state(state)
}

const ADMIN_TOKEN_HEADER: &str = "X-Flora-Admin-Token";

#[derive(Debug, Deserialize)]
struct BroadcastUpdateBody {
    version: String,
    #[serde(rename = "versionCode")]
    version_code: i64,
    #[serde(rename = "apkUrl")]
    apk_url: String,
    sha256: String,
    #[serde(rename = "sizeBytes")]
    size_bytes: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct BroadcastRequest {
    text: Option<String>,
    #[serde(rename = "type")]
    notification_type: Option<String>,
    category: Option<String>,
    platform: Option<String>,
    /// Optional sideload manifest (not persisted; forwarded on FCM/SSE for `app_update`).
    update: Option<BroadcastUpdateBody>,
}

async fn broadcast_notification(
    State(state): State<AdminBroadcastState>,
    headers: HeaderMap,
    Json(body): Json<BroadcastRequest>,
) -> Response {
    let Some(configured) = state.admin_token.as_deref() else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Админ-рассылка отключена." })),
        )
            .into_response();
    };

    let client_key = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("anon");
    if !state.rate_limiter.check_and_increment(client_key) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }

    let provided = headers
        .get(ADMIN_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim();
    if !is_valid_admin_token(configured, provided) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Неверный токен администратора." })),
        )
            .into_response();
    }

    let text = body.text.as_deref().map(str::trim).unwrap_or("");
    if text.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Укажите текст уведомления." })),
        )
            .into_response();
    }

    let notification_type = body
        .notification_type
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("app_update");
    let category = body
        .category
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("developer");
    let platform = body
        .platform
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let update = body.update.and_then(|u| {
        let version = u.version.trim().to_string();
        let apk_url = u.apk_url.trim().to_string();
        let sha256 = u.sha256.trim().to_ascii_lowercase();
        if version.is_empty() || apk_url.is_empty() || u.version_code < 1 {
            return None;
        }
        if sha256.len() != 64 || !sha256.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        Some(AppUpdatePayload {
            version,
            version_code: u.version_code,
            apk_url,
            sha256,
            size_bytes: u.size_bytes.filter(|s| *s > 0),
        })
    });

    if notification_type == "app_update" && update.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Для app_update укажите update{version,versionCode,apkUrl,sha256}."
            })),
        )
            .into_response();
    }

    match state
        .inbox
        .broadcast(notification_type, category, text, platform, update)
        .await
    {
        Ok(recipients) => Json(serde_json::json!({ "recipients": recipients })).into_response(),
        Err(e) => {
            if e.contains("app_update broadcast requires update") {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "error": e })),
                )
                    .into_response();
            }
            internal(e)
        }
    }
}

/// Паритет `AdminNotificationsController.IsValidAdminToken` — UTF-8 bytes, length + ct_eq.
fn is_valid_admin_token(configured: &str, provided: &str) -> bool {
    if provided.is_empty() {
        return false;
    }
    let expected = configured.as_bytes();
    let actual = provided.as_bytes();
    expected.len() == actual.len() && bool::from(expected.ct_eq(actual))
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    category: Option<String>,
    search: Option<String>,
    #[serde(default)]
    skip: i32,
    #[serde(default = "default_take")]
    take: i32,
}

fn default_take() -> i32 {
    50
}

fn platform_from_headers(headers: &HeaderMap) -> Option<String> {
    client_platform_from_header(headers.get("X-Flora-Client").and_then(|v| v.to_str().ok()))
}

async fn list_notifications(
    State(state): State<NotificationsState>,
    Extension(user): Extension<CurrentUser>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> Response {
    let platform = platform_from_headers(&headers);
    match state
        .inbox
        .list(
            user.0,
            q.category.as_deref(),
            q.search.as_deref(),
            q.skip,
            q.take,
            platform.as_deref(),
        )
        .await
    {
        Ok(items) => Json(items).into_response(),
        Err(e) => internal(e),
    }
}

async fn unread_count(
    State(state): State<NotificationsState>,
    Extension(user): Extension<CurrentUser>,
    headers: HeaderMap,
) -> Response {
    let platform = platform_from_headers(&headers);
    match state.inbox.unread_count(user.0, platform.as_deref()).await {
        Ok(count) => Json(serde_json::json!({ "unreadCount": count })).into_response(),
        Err(e) => internal(e),
    }
}

async fn mark_read(
    State(state): State<NotificationsState>,
    Extension(user): Extension<CurrentUser>,
    Path(notification_uuid): Path<Uuid>,
) -> Response {
    match state.inbox.mark_read(user.0, notification_uuid).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Уведомление не найдено." })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

async fn mark_all_read(
    State(state): State<NotificationsState>,
    Extension(user): Extension<CurrentUser>,
    headers: HeaderMap,
) -> Response {
    let platform = platform_from_headers(&headers);
    match state.inbox.mark_all_read(user.0, platform.as_deref()).await {
        Ok(marked) => Json(serde_json::json!({ "marked": marked })).into_response(),
        Err(e) => internal(e),
    }
}

async fn delete_all(
    State(state): State<NotificationsState>,
    Extension(user): Extension<CurrentUser>,
    headers: HeaderMap,
) -> Response {
    let platform = platform_from_headers(&headers);
    match state.inbox.delete_all(user.0, platform.as_deref()).await {
        Ok(deleted) => Json(serde_json::json!({ "deleted": deleted })).into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
struct DeleteNotificationsRequest {
    #[serde(rename = "notificationUuids")]
    notification_uuids: Option<Vec<Uuid>>,
}

async fn delete_notifications(
    State(state): State<NotificationsState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<DeleteNotificationsRequest>,
) -> Response {
    let uuids = body.notification_uuids.unwrap_or_default();
    if uuids.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Укажите уведомления для удаления." })),
        )
            .into_response();
    }
    match state.inbox.delete(user.0, uuids).await {
        Ok(deleted) => Json(serde_json::json!({ "deleted": deleted })).into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushTokenRequest {
    token: Option<String>,
    platform: Option<String>,
    provider: Option<String>,
    installation_uuid: Option<Uuid>,
    secure_preview_version: Option<i32>,
    preview_key_id: Option<Uuid>,
    preview_public_key_base64_url: Option<String>,
}

async fn register_push_token(
    State(state): State<NotificationsState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<PushTokenRequest>,
) -> Response {
    let token = body.token.as_deref().map(str::trim).unwrap_or("");
    if token.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Укажите push token." })),
        )
            .into_response();
    }
    let secure_fields = [
        body.installation_uuid.is_some(),
        body.secure_preview_version.is_some(),
        body.preview_key_id.is_some(),
        body.preview_public_key_base64_url.is_some(),
    ];
    if secure_fields.iter().any(|present| *present) && !secure_fields.iter().all(|present| *present)
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Secure preview capability задан неполностью." })),
        )
            .into_response();
    }
    let secure_preview = match (
        body.installation_uuid,
        body.secure_preview_version,
        body.preview_key_id,
        body.preview_public_key_base64_url.as_deref(),
    ) {
        (
            Some(installation_uuid),
            Some(protocol_version),
            Some(preview_key_id),
            Some(public_key),
        ) => Some(SecurePreviewRegistration {
            installation_uuid,
            protocol_version,
            preview_key_id,
            public_key_base64_url: public_key,
        }),
        _ => None,
    };
    match state
        .push_tokens
        .register(
            user.0,
            token,
            body.platform.as_deref(),
            body.provider.as_deref(),
            secure_preview,
        )
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn unregister_push_token(
    State(state): State<NotificationsState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<PushTokenRequest>,
) -> Response {
    let token = body.token.as_deref().map(str::trim).unwrap_or("");
    if token.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Укажите push token." })),
        )
            .into_response();
    }
    match state.push_tokens.unregister(user.0, token).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => internal(e),
    }
}

async fn signals_stream(
    State(state): State<NotificationsState>,
    Extension(user): Extension<CurrentUser>,
) -> impl IntoResponse {
    let frames = state.hub.subscribe(user.0);
    let stream = frames
        .map(|frame| Ok::<Event, Infallible>(Event::default().event(frame.event).data(frame.data)));

    let sse = Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(25))
            .text("ping"),
    );

    // Паритет SignalsController: Cache-Control + Connection (Content-Type задаёт Sse).
    (
        [
            (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
            (header::CONNECTION, HeaderValue::from_static("keep-alive")),
        ],
        sse,
    )
}

fn internal(e: String) -> Response {
    tracing::error!(error = %e, "notifications http failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": "Внутренняя ошибка сервера." })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::is_valid_admin_token;

    #[test]
    fn admin_token_rejects_empty_and_mismatch() {
        assert!(!is_valid_admin_token("secret", ""));
        assert!(!is_valid_admin_token("secret", "wrong"));
        assert!(!is_valid_admin_token("secret", "secre"));
        assert!(is_valid_admin_token("secret", "secret"));
    }
}
