//! Auth HTTP — Фаза 2b: sessions list/revoke-others + logout.

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use uuid::Uuid;

use crate::application::sessions::SessionService;

/// Пользователь + jti из access-токена (внедряет flora-social JWT middleware).
#[derive(Clone, Debug)]
pub struct AuthUser {
    pub user_uuid: Uuid,
    pub jti: String,
}

#[derive(Clone)]
pub struct AuthState {
    pub sessions: Arc<SessionService>,
}

pub fn router(state: AuthState) -> Router {
    Router::new()
        .route("/api/auth/me/sessions", get(list_my_sessions))
        .route("/api/auth/me/sessions/others", delete(revoke_other_sessions))
        .route("/api/auth/logout", post(logout))
        .with_state(state)
}

async fn list_my_sessions(
    State(state): State<AuthState>,
    Extension(user): Extension<AuthUser>,
) -> Response {
    match state.sessions.list_active(user.user_uuid, &user.jti).await {
        Ok(items) => Json(items).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "list sessions failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Внутренняя ошибка сервера." })),
            )
                .into_response()
        }
    }
}

async fn revoke_other_sessions(
    State(state): State<AuthState>,
    Extension(user): Extension<AuthUser>,
) -> Response {
    match state.sessions.revoke_others(user.user_uuid, &user.jti).await {
        Ok(revoked) => Json(RevokeOthersResponse { revoked }).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "revoke other sessions failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Внутренняя ошибка сервера." })),
            )
                .into_response()
        }
    }
}

async fn logout(
    State(state): State<AuthState>,
    Extension(user): Extension<AuthUser>,
) -> Response {
    match state.sessions.logout_current(&user.jti).await {
        Ok(()) => StatusCode::OK.into_response(),
        Err(e) => {
            tracing::error!(error = %e, "logout failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Внутренняя ошибка сервера." })),
            )
                .into_response()
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListItem {
    pub session_id: Uuid,
    pub created_at: String,
    pub last_activity: String,
    pub ip_address: String,
    pub city: Option<String>,
    pub country_code: Option<String>,
    pub is_current: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeOthersResponse {
    pub revoked: u64,
}

pub fn format_utc(dt: DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn session_list_item_json_shape() {
        let item = SessionListItem {
            session_id: Uuid::parse_str("01900000-0000-7000-8000-000000000001").unwrap(),
            created_at: "2026-07-14T12:00:00.000Z".into(),
            last_activity: "2026-07-14T12:30:00.000Z".into(),
            ip_address: "127.0.0.1".into(),
            city: None,
            country_code: Some("RU".into()),
            is_current: true,
        };
        let v = serde_json::to_value(&item).unwrap();
        assert_eq!(v["sessionId"], "01900000-0000-7000-8000-000000000001");
        assert_eq!(v["ipAddress"], "127.0.0.1");
        assert_eq!(v["countryCode"], "RU");
        assert!(v["city"].is_null());
        assert_eq!(v["isCurrent"], true);
        assert_eq!(
            format_utc(Utc.with_ymd_and_hms(2026, 7, 14, 12, 0, 0).unwrap()),
            "2026-07-14T12:00:00.000Z"
        );
    }

    #[test]
    fn revoke_others_response_json_shape() {
        let v = serde_json::to_value(RevokeOthersResponse { revoked: 3 }).unwrap();
        assert_eq!(v, serde_json::json!({ "revoked": 3 }));
    }
}
