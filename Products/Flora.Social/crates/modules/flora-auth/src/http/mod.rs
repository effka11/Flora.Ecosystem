//! Auth HTTP — Фаза 2b: sessions, logout, me/security, refresh, login, register.

mod rate_limit;

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Extension, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::application::account::{AccountService, ChangePasswordError, DeleteAccountError};
use crate::application::login::{
    LoginError, LoginService, SessionHints, agent_hash_from_user_agent, clamp_ip,
    resolve_identifier,
};
use crate::application::refresh::{RefreshError, RefreshService};
use crate::application::register::{RegisterBeginError, RegisterService, RegisterVerifyError};
use crate::application::security::{SecurityMutationError, SecurityService};
use crate::application::sessions::SessionService;
use crate::http::rate_limit::{
    AnonymousAuthLimiters, account_sensitive_limiter, account_sensitive_rate_limit,
    anonymous_auth_rate_limit,
};

/// Пользователь из access-токена (внедряет flora-social JWT middleware).
///
/// `session_id` — стабильный id сессии, разрешённый по JTI на этапе валидации.
/// logout/revoke-others/password оперируют по нему, поэтому параллельная ротация
/// JTI (в grace) не может обойти logout и не путает сессию с чужой. `jti`
/// оставлен для совместимости и диагностики.
#[derive(Clone, Debug)]
pub struct AuthUser {
    pub user_uuid: Uuid,
    pub jti: String,
    pub session_id: Uuid,
}

#[derive(Clone)]
pub struct AuthState {
    pub sessions: Arc<SessionService>,
    pub security: Arc<SecurityService>,
    pub account: Arc<AccountService>,
}

#[derive(Clone)]
pub struct PublicAuthState {
    pub refresh: Arc<RefreshService>,
    pub login: Arc<LoginService>,
    pub register: Arc<RegisterService>,
}

/// Маршруты с JWT (flora-social вешает Bearer middleware).
pub fn protected_router(state: AuthState) -> Router {
    let sensitive = account_sensitive_limiter();
    Router::new()
        .route("/api/auth/me/sessions", get(list_my_sessions))
        .route(
            "/api/auth/me/sessions/others",
            delete(revoke_other_sessions),
        )
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/me/security", get(get_my_security))
        .route("/api/auth/me/password", patch(change_password))
        .route("/api/auth/delete-account", post(delete_account))
        .route("/api/auth/me/email/change", post(begin_email_change))
        .route("/api/auth/me/email/confirm", post(confirm_email_change))
        .route("/api/auth/me/phone", patch(change_phone))
        .route("/api/auth/me/2fa/setup", post(begin_two_factor_setup))
        .route("/api/auth/me/2fa/enable", post(enable_two_factor))
        .route("/api/auth/me/2fa", delete(disable_two_factor))
        .with_state(state)
        .layer(axum::middleware::from_fn_with_state(
            sensitive,
            account_sensitive_rate_limit,
        ))
}

/// Анонимные маршруты (без JWT). Rate-limit: login/refresh/register/verify.
pub fn public_router(state: PublicAuthState) -> Router {
    let limiters = AnonymousAuthLimiters::social_defaults();
    Router::new()
        .route("/api/auth/refresh", post(refresh))
        .route("/api/auth/login", post(login))
        .route("/api/auth/register", post(register))
        .route("/api/auth/verify-registration", post(verify_registration))
        .route("/api/auth/cancel-registration", post(cancel_registration))
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
    match state
        .sessions
        .list_active(user.user_uuid, user.session_id)
        .await
    {
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
    match state
        .sessions
        .revoke_others(user.user_uuid, user.session_id)
        .await
    {
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

async fn logout(State(state): State<AuthState>, Extension(user): Extension<AuthUser>) -> Response {
    match state.sessions.logout_current(user.session_id).await {
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
pub struct ChangePasswordRequest {
    #[serde(alias = "CurrentPassword")]
    pub current_password: Option<String>,
    #[serde(alias = "NewPassword")]
    pub new_password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAccountRequest {
    #[serde(alias = "Password")]
    pub password: Option<String>,
}

async fn change_password(
    State(state): State<AuthState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<ChangePasswordRequest>,
) -> Response {
    match state
        .account
        .change_password(
            user.user_uuid,
            user.session_id,
            body.current_password.as_deref().unwrap_or(""),
            body.new_password.as_deref().unwrap_or(""),
        )
        .await
    {
        Ok(()) => Json(serde_json::json!({ "message": "Пароль изменён." })).into_response(),
        Err(ChangePasswordError::BadRequest(msg)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(ChangePasswordError::NotFound(msg)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(ChangePasswordError::Internal(e)) => {
            tracing::error!(error = %e, "change password failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Внутренняя ошибка сервера." })),
            )
                .into_response()
        }
    }
}

async fn delete_account(
    State(state): State<AuthState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<DeleteAccountRequest>,
) -> Response {
    match state
        .account
        .delete_account(user.user_uuid, body.password.as_deref().unwrap_or(""))
        .await
    {
        Ok(()) => Json(serde_json::json!({ "message": "Аккаунт удалён." })).into_response(),
        Err(DeleteAccountError::BadRequest(msg)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(DeleteAccountError::NotFound(msg)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(DeleteAccountError::Internal(e)) => {
            tracing::error!(error = %e, "delete account failed");
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
pub struct BeginEmailChangeRequest {
    #[serde(alias = "Password")]
    pub password: Option<String>,
    #[serde(alias = "NewEmail")]
    pub new_email: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmEmailChangeRequest {
    #[serde(alias = "ChangeToken")]
    pub change_token: Option<String>,
    #[serde(alias = "Code")]
    pub code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePhoneRequest {
    #[serde(alias = "Password")]
    pub password: Option<String>,
    #[serde(alias = "Phone")]
    pub phone: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TwoFactorPasswordRequest {
    #[serde(alias = "Password")]
    pub password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TwoFactorCodeRequest {
    #[serde(alias = "Code")]
    pub code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisableTwoFactorRequest {
    #[serde(alias = "Password")]
    pub password: Option<String>,
    #[serde(alias = "Code")]
    pub code: Option<String>,
}

fn security_mutation_response(err: SecurityMutationError) -> Response {
    match err {
        SecurityMutationError::BadRequest(msg) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        SecurityMutationError::Conflict(msg) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        SecurityMutationError::Internal(e) => {
            tracing::error!(error = %e, "account security mutation failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Внутренняя ошибка сервера." })),
            )
                .into_response()
        }
    }
}

async fn begin_email_change(
    State(state): State<AuthState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<BeginEmailChangeRequest>,
) -> Response {
    match state
        .security
        .begin_email_change(
            user.user_uuid,
            body.password.as_deref().unwrap_or(""),
            body.new_email.as_deref().unwrap_or(""),
        )
        .await
    {
        Ok(resp) => Json(resp).into_response(),
        Err(e) => security_mutation_response(e),
    }
}

async fn confirm_email_change(
    State(state): State<AuthState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<ConfirmEmailChangeRequest>,
) -> Response {
    match state
        .security
        .confirm_email_change(
            user.user_uuid,
            body.change_token.as_deref().unwrap_or(""),
            body.code.as_deref().unwrap_or(""),
        )
        .await
    {
        Ok(email) => Json(serde_json::json!({
            "email": email,
            "message": "Email обновлён."
        }))
        .into_response(),
        Err(e) => security_mutation_response(e),
    }
}

async fn change_phone(
    State(state): State<AuthState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<ChangePhoneRequest>,
) -> Response {
    match state
        .security
        .change_phone(
            user.user_uuid,
            body.password.as_deref().unwrap_or(""),
            body.phone.as_deref().unwrap_or(""),
        )
        .await
    {
        Ok(()) => Json(serde_json::json!({
            "message": "Номер телефона обновлён. Подтверждение по SMS будет доступно позже."
        }))
        .into_response(),
        Err(e) => security_mutation_response(e),
    }
}

async fn begin_two_factor_setup(
    State(state): State<AuthState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<TwoFactorPasswordRequest>,
) -> Response {
    match state
        .security
        .begin_two_factor_setup(user.user_uuid, body.password.as_deref().unwrap_or(""))
        .await
    {
        Ok(resp) => Json(resp).into_response(),
        Err(e) => security_mutation_response(e),
    }
}

async fn enable_two_factor(
    State(state): State<AuthState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<TwoFactorCodeRequest>,
) -> Response {
    match state
        .security
        .enable_two_factor(user.user_uuid, body.code.as_deref().unwrap_or(""))
        .await
    {
        Ok(()) => Json(serde_json::json!({
            "message": "Двухфакторная аутентификация включена."
        }))
        .into_response(),
        Err(e) => security_mutation_response(e),
    }
}

async fn disable_two_factor(
    State(state): State<AuthState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<DisableTwoFactorRequest>,
) -> Response {
    match state
        .security
        .disable_two_factor(
            user.user_uuid,
            body.password.as_deref().unwrap_or(""),
            body.code.as_deref().unwrap_or(""),
        )
        .await
    {
        Ok(()) => Json(serde_json::json!({
            "message": "Двухфакторная аутентификация отключена."
        }))
        .into_response(),
        Err(e) => security_mutation_response(e),
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    #[serde(alias = "Email")]
    pub email: Option<String>,
    #[serde(alias = "Phone")]
    pub phone: Option<String>,
    #[serde(alias = "Password")]
    pub password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRegistrationRequest {
    #[serde(alias = "VerificationToken")]
    pub verification_token: Option<String>,
    #[serde(alias = "Code")]
    pub code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRegistrationRequest {
    #[serde(alias = "VerificationToken")]
    pub verification_token: Option<String>,
}

async fn refresh(
    State(state): State<PublicAuthState>,
    Json(body): Json<RefreshRequest>,
) -> Response {
    let token = body.refresh_token.unwrap_or_default();
    match state.refresh.refresh(&token).await {
        Ok(resp) => Json(resp).into_response(),
        Err(RefreshError::BadRequest(msg)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(RefreshError::Unauthorized(msg)) => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(RefreshError::ServiceUnavailable(msg)) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(RefreshError::Internal(e)) => {
            tracing::error!(
                target: "flora_auth::refresh_outcome",
                metric = "refresh_error",
                outcome = "internal",
                status = 500_u16,
                counter_delta = 1_u64,
                error = %e,
                "refresh failed"
            );
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
    let hints = session_hints_from_headers(&headers);
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
        Err(LoginError::BadRequest(msg)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(LoginError::Unauthorized(msg)) => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
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

async fn register(
    State(state): State<PublicAuthState>,
    Json(body): Json<RegisterRequest>,
) -> Response {
    let email = resolve_identifier(body.email.as_deref(), body.phone.as_deref());
    match state
        .register
        .begin(&email, body.password.as_deref().unwrap_or(""))
        .await
    {
        Ok(resp) => Json(resp).into_response(),
        Err(RegisterBeginError::BadRequest(msg)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(RegisterBeginError::Conflict(msg)) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(RegisterBeginError::Internal(e)) => {
            tracing::error!(error = %e, "register begin failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Внутренняя ошибка сервера." })),
            )
                .into_response()
        }
    }
}

async fn verify_registration(
    State(state): State<PublicAuthState>,
    headers: HeaderMap,
    Json(body): Json<VerifyRegistrationRequest>,
) -> Response {
    let Some(token) = body
        .verification_token
        .as_deref()
        .and_then(|s| Uuid::parse_str(s.trim()).ok())
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Некорректный токен верификации." })),
        )
            .into_response();
    };
    let hints = session_hints_from_headers(&headers);
    match state
        .register
        .verify(token, body.code.as_deref().unwrap_or(""), hints)
        .await
    {
        Ok(resp) => Json(resp).into_response(),
        Err(RegisterVerifyError::BadRequest(msg)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(RegisterVerifyError::Conflict(msg)) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(RegisterVerifyError::Unauthorized(msg)) => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(RegisterVerifyError::Internal(e)) => {
            tracing::error!(error = %e, "verify registration failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Внутренняя ошибка сервера." })),
            )
                .into_response()
        }
    }
}

async fn cancel_registration(
    State(state): State<PublicAuthState>,
    Json(body): Json<CancelRegistrationRequest>,
) -> Response {
    let Some(token) = body
        .verification_token
        .as_deref()
        .and_then(|s| Uuid::parse_str(s.trim()).ok())
    else {
        return StatusCode::OK.into_response();
    };
    if let Err(e) = state.register.cancel(token).await {
        tracing::warn!(error = %e, "cancel registration best-effort failed");
    }
    StatusCode::OK.into_response()
}

fn session_hints_from_headers(headers: &HeaderMap) -> SessionHints {
    let ip = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').map(str::trim).find(|p| !p.is_empty()))
        .unwrap_or("unknown");
    let ua = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    SessionHints {
        ip: clamp_ip(ip),
        agent_hash: agent_hash_from_user_agent(ua),
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
pub struct RegisterInitResponse {
    pub verification_token: String,
    pub expires_at: String,
    pub dev_verification_code: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailChangeBeginResponse {
    pub change_token: String,
    pub expires_at: String,
    pub dev_verification_code: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwoFactorSetupResponse {
    pub secret: String,
    pub otp_auth_uri: String,
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

    #[test]
    fn register_init_response_json_shape() {
        let v = serde_json::to_value(RegisterInitResponse {
            verification_token: "01900000-0000-7000-8000-000000000099".into(),
            expires_at: "2026-07-14T12:15:00.000Z".into(),
            dev_verification_code: Some("123456".into()),
        })
        .unwrap();
        assert_eq!(
            v["verificationToken"],
            "01900000-0000-7000-8000-000000000099"
        );
        assert_eq!(v["expiresAt"], "2026-07-14T12:15:00.000Z");
        assert_eq!(v["devVerificationCode"], "123456");
    }
}
