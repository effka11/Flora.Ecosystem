//! Модуль Auth. Фаза 2b: JWT с Фазы 0; HTTP — по срезам (`Auth:ServeNative`).

pub mod application;
pub mod http;
pub mod infrastructure;

use std::sync::Arc;

use sqlx::PgPool;

use crate::application::sessions::SessionService;
use crate::http::AuthState;
use crate::infrastructure::repo::AuthRepo;

/// Собранный модуль Auth (нативные маршруты при ServeNative).
pub struct AuthModule {
    pub router: axum::Router,
}

/// Пустой роутер — gateway-fallback на .NET.
pub fn router() -> axum::Router {
    axum::Router::new()
}

pub fn compose(pool: PgPool) -> AuthModule {
    let repo = Arc::new(AuthRepo::new(pool));
    let sessions = Arc::new(SessionService::new(repo));
    AuthModule {
        router: http::router(AuthState { sessions }),
    }
}
