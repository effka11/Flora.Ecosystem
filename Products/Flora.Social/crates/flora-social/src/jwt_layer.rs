//! JWT Bearer для нативных маршрутов продукта (не в модулях — §2.3).

use axum::Json;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use flora_auth::http::AuthUser;
use flora_auth::infrastructure::jwt::{JwtOptions, validate_access_token};
use flora_music::http::CurrentUser;
use uuid::Uuid;

#[derive(Clone)]
pub struct JwtAuthState {
    pub options: JwtOptions,
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
    // Music / Auth / Users / Content / Messaging / Notifications share the same JWT identity.
    req.extensions_mut().insert(CurrentUser(user_uuid));
    req.extensions_mut()
        .insert(flora_users::http::CurrentUser { user_uuid });
    req.extensions_mut()
        .insert(flora_content::http::CurrentUser(user_uuid));
    req.extensions_mut()
        .insert(flora_messaging::http::CurrentUser(user_uuid));
    req.extensions_mut()
        .insert(flora_notifications::http::CurrentUser(user_uuid));
    req.extensions_mut().insert(AuthUser {
        user_uuid,
        jti: claims.jti,
    });
    next.run(req).await
}

/// Опциональный JWT: при валидном Bearer вставляет `CurrentUser`, иначе пропускает анонимно.
pub async fn optional_bearer_jwt(
    State(auth): State<JwtAuthState>,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    if let Some(header) = req.headers().get(axum::http::header::AUTHORIZATION)
        && let Ok(value) = header.to_str()
        && let Some(token) = value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
    {
        let now = chrono::Utc::now().timestamp();
        if let Ok(claims) = validate_access_token(&auth.options, token, now)
            && let Ok(user_uuid) = Uuid::parse_str(&claims.sub)
        {
            req.extensions_mut()
                .insert(flora_content::http::CurrentUser(user_uuid));
            req.extensions_mut()
                .insert(flora_users::http::CurrentUser { user_uuid });
        }
    }
    next.run(req).await
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({ "error": "Не удалось определить пользователя." })),
    )
        .into_response()
}
