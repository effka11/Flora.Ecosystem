//! Auth HTTP — Фаза 2b: sessions, logout, me/security, refresh.

mod rate_limit;

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Extension, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::application::login::{
    LoginError, LoginService, SessionHints, agent_hash_from_user_agent, clamp_ip,
};
use crate::application::refresh::{RefreshError, RefreshService};
use crate::application::security::SecurityService;
use crate::application::sessions::SessionService;
use crate::http::rate_limit::{AnonymousAuthLimiters, anonymous_auth_rate_limit};

/// Пользователь + jti из access-токена (внедряет flora-social JWT middleware).
#[derive(Clone, Debug)]
pub struct AuthUser {
    pub user_uuid: Uuid,
    pub jti: String,
}

#[derive(Clone)]
pub struct AuthState {
    pub sessions: Arc<SessionService>,
    pub security: Arc<SecurityService>,
}

#[derive(Clone)]
pub struct PublicAuthState {
    pub refresh: Arc<RefreshService>,
    pub login: Arc<LoginService>,
}

/// Маршруты с JWT (flora-social вешает Bearer middleware).
pub fn protected_router(state: AuthState) -> Router {
    Router::new()
        .route("/api/auth/me/sessions", get(list_my_sessions))
        .route("/api/auth/me/sessions/others", delete(revoke_other_sessions))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/me/security", get(get_my_security))
        .with_state(state)
}

/// Анонимные маршруты (без JWT). Rate-limit: login 10/5м, refresh 60/5м.
pub fn public_router(state: PublicAuthState) -> Router {
    let limiters = AnonymousAuthLimiters::social_defaults();
    Router::new()
        .route("/api/auth/refresh", post(refresh))
        .route("/api/auth/login", post(login))
        .with_state(state)
        .layer(axum::middleware::from_fn_with_state(
            limiters,
            anonymous_auth_rate_limit,
        ))
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

async fn get_my_security(
    State(state): State<AuthState>,
    Extension(user): Extension<AuthUser>,
) -> Response {
    match state.security.status(user.user_uuid).await {
        Ok(status) => Json(status).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "get security status failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Внутренняя ошибка сервера." })),
            )
                .into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshRequest {
    #[serde(alias = "RefreshToken")]
    pub refresh_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    #[serde(alias = "Email")]
    pub email: Option<String>,
    #[serde(alias = "Phone")]
    pub phone: Option<String>,
    #[serde(alias = "Password")]
    pub password: Option<String>,
    #[serde(alias = "TwoFactorCode")]
    pub two_factor_code: Option<String>,
}

async fn refresh(
    State(state): State<PublicAuthState>,
    Json(body): Json<RefreshRequest>,
) -> Response {
    let token = body.refresh_token.unwrap_or_default();
    match state.refresh.refresh(&token).await {
        Ok(resp) => Json(resp).into_response(),
        Err(RefreshError::BadRequest(msg)) => {
            (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": msg }))).into_response()
        }
        Err(RefreshError::Unauthorized(msg)) => {
            (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": msg })),
            )
                .into_response()
        }
        Err(RefreshError::Internal(e)) => {
            tracing::error!(error = %e, "refresh failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Внутренняя ошибка сервера." })),
            )
                .into_response()
        }
    }
}

async fn login(
    State(state): State<PublicAuthState>,
    headers: HeaderMap,
    Json(body): Json<LoginRequest>,
) -> Response {
    let ip = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').map(str::trim).find(|p| !p.is_empty()))
        .unwrap_or("unknown");
    let ua = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let hints = SessionHints {
        ip: clamp_ip(ip),
        agent_hash: agent_hash_from_user_agent(ua),
    };

    match state
        .login
        .login(
            body.email.as_deref(),
            body.phone.as_deref(),
            body.password.as_deref().unwrap_or(""),
            body.two_factor_code.as_deref(),
            hints,
        )
        .await
    {
        Ok(resp) => Json(resp).into_response(),
        Err(LoginError::BadRequest(msg)) => {
            (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": msg }))).into_response()
        }
        Err(LoginError::Unauthorized(msg)) => {
            (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": msg })),
            )
                .into_response()
        }
        Err(LoginError::TwoFactor(challenge)) => Json(challenge).into_response(),
        Err(LoginError::Internal(e)) => {
            tracing::error!(error = %e, "login failed");
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityStatusResponse {
    pub two_factor_enabled: bool,
    pub email_verified: bool,
    pub phone_verified: bool,
}

/// Паритет `LoginResponse` (login/refresh/verify).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: String,
    pub token_type: String,
    pub requires_profile_completion: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwoFactorChallengeResponse {
    pub requires_two_factor: bool,
    pub error: Option<String>,
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

    #[test]
    fn security_status_json_shape() {
        let v = serde_json::to_value(SecurityStatusResponse {
            two_factor_enabled: true,
            email_verified: false,
            phone_verified: true,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "twoFactorEnabled": true,
                "emailVerified": false,
                "phoneVerified": true,
            })
        );
    }

    #[test]
    fn login_response_json_shape() {
        let v = serde_json::to_value(LoginResponse {
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at: "2026-07-14T12:00:00.000Z".into(),
            token_type: "Bearer".into(),
            requires_profile_completion: true,
        })
        .unwrap();
        assert_eq!(v["accessToken"], "a");
        assert_eq!(v["refreshToken"], "r");
        assert_eq!(v["expiresAt"], "2026-07-14T12:00:00.000Z");
        assert_eq!(v["tokenType"], "Bearer");
        assert_eq!(v["requiresProfileCompletion"], true);
    }
}
