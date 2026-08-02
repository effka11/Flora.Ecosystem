//! JWT Bearer для нативных маршрутов продукта (не в модулях — §2.3).

use std::sync::Arc;

use axum::Json;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, Request, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use flora_auth::http::AuthUser;
use flora_auth::infrastructure::jwt::{JwtOptions, validate_access_token};
use flora_auth_contracts::AccessSessionValidator;
use flora_music::http::CurrentUser;
use uuid::Uuid;

const HOST_MEDIA_ACCESS_COOKIE_NAME: &str = "__Host-flora_media_access";
const DEV_MEDIA_ACCESS_COOKIE_NAME: &str = "flora_media_access";

#[derive(Clone)]
pub struct JwtAuthState {
    pub options: JwtOptions,
    pub sessions: Option<Arc<dyn AccessSessionValidator>>,
}

pub async fn require_bearer_jwt(
    State(auth): State<JwtAuthState>,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    let Some(header) = req.headers().get(axum::http::header::AUTHORIZATION) else {
        return unauthorized();
    };
    let Ok(value) = header.to_str() else {
        return unauthorized();
    };
    let Some(token) = value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
    else {
        return unauthorized();
    };
    let now = chrono::Utc::now().timestamp();
    let Ok(claims) = validate_access_token(&auth.options, token, now) else {
        return unauthorized();
    };
    let Ok(user_uuid) = Uuid::parse_str(&claims.sub) else {
        return unauthorized();
    };
    let Some(sessions) = auth.sessions.as_ref() else {
        return unauthorized();
    };
    let session_id = match sessions
        .resolve_active_session(user_uuid, &claims.jti)
        .await
    {
        Ok(Some(session_id)) => session_id,
        Ok(None) => return unauthorized(),
        Err(error) => {
            tracing::warn!(%error, "JWT session validation failed");
            return unauthorized();
        }
    };
    // Music / Auth / Users / Content / Messaging / ChatOrganizer / Notifications share JWT identity.
    req.extensions_mut().insert(CurrentUser(user_uuid));
    req.extensions_mut()
        .insert(flora_users::http::CurrentUser { user_uuid });
    req.extensions_mut()
        .insert(flora_content::http::CurrentUser(user_uuid));
    req.extensions_mut()
        .insert(flora_messaging::http::CurrentUser(user_uuid));
    req.extensions_mut()
        .insert(flora_chat_organizer::http::CurrentUser(user_uuid));
    req.extensions_mut()
        .insert(flora_notifications::http::CurrentUser(user_uuid));
    req.extensions_mut().insert(AuthUser {
        user_uuid,
        jti: claims.jti,
        session_id,
    });
    next.run(req).await
}

/// Опциональный JWT: при валидном Bearer вставляет `CurrentUser`, иначе пропускает анонимно.
pub async fn optional_bearer_jwt(
    State(auth): State<JwtAuthState>,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    let token = bearer_token(req.headers())
        .or_else(|| cookie_value(req.headers(), HOST_MEDIA_ACCESS_COOKIE_NAME))
        .or_else(|| cookie_value(req.headers(), DEV_MEDIA_ACCESS_COOKIE_NAME));
    if let Some(token) = token {
        let now = chrono::Utc::now().timestamp();
        if let Ok(claims) = validate_access_token(&auth.options, token, now)
            && let Ok(user_uuid) = Uuid::parse_str(&claims.sub)
            && let Some(sessions) = auth.sessions.as_ref()
            && matches!(
                sessions
                    .resolve_active_session(user_uuid, &claims.jti)
                    .await,
                Ok(Some(_))
            )
        {
            req.extensions_mut()
                .insert(flora_content::http::CurrentUser(user_uuid));
            req.extensions_mut()
                .insert(flora_users::http::CurrentUser { user_uuid });
        }
    }
    next.run(req).await
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
}

fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find_map(|(key, value)| (key == name && !value.is_empty()).then_some(value))
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({ "error": "Не удалось определить пользователя." })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn media_access_cookie_is_parsed_without_accepting_similar_names() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static(
                "flora_media_access_shadow=bad; flora_media_access=header.payload.signature",
            ),
        );
        assert_eq!(
            cookie_value(&headers, DEV_MEDIA_ACCESS_COOKIE_NAME),
            Some("header.payload.signature")
        );
    }
}
