//! Модуль Auth. Фаза 2b: JWT с Фазы 0; HTTP — по срезам (`Auth:ServeNative`).

pub mod application;
pub mod domain;
pub mod http;
pub mod infrastructure;

use std::sync::Arc;

use flora_users_contracts::{UserProfileProvisioner, UserProfileReadQueries};
use flora_verification_contracts::VerificationChallengePort;
use sqlx::PgPool;

use crate::application::login::LoginService;
use crate::application::refresh::RefreshService;
use crate::application::register::RegisterService;
use crate::application::security::SecurityService;
use crate::application::sessions::SessionService;
use crate::http::{AuthState, PublicAuthState};
use crate::infrastructure::jwt::JwtOptions;
use crate::infrastructure::repo::AuthRepo;

/// Собранный модуль Auth (нативные маршруты при ServeNative).
pub struct AuthModule {
    /// JWT-защищённые маршруты.
    pub protected_router: axum::Router,
    /// Анонимные (login/refresh/register/verify/cancel).
    pub public_router: axum::Router,
}

/// Пустой роутер — gateway-fallback на .NET.
pub fn router() -> axum::Router {
    axum::Router::new()
}

pub fn compose(
    pool: PgPool,
    jwt: JwtOptions,
    profiles: Arc<dyn UserProfileReadQueries>,
    provisioner: Arc<dyn UserProfileProvisioner>,
    verification: Arc<dyn VerificationChallengePort>,
) -> AuthModule {
    let repo = Arc::new(AuthRepo::new(pool));
    let sessions = Arc::new(SessionService::new(repo.clone()));
    let security = Arc::new(SecurityService::new(repo.clone()));
    let refresh = Arc::new(RefreshService::new(
        repo.clone(),
        jwt.clone(),
        profiles.clone(),
    ));
    let login = Arc::new(LoginService::new(
        repo.clone(),
        jwt.clone(),
        profiles.clone(),
    ));
    let register = Arc::new(RegisterService::new(
        repo,
        jwt,
        verification,
        profiles,
        provisioner,
    ));
    AuthModule {
        protected_router: http::protected_router(AuthState { sessions, security }),
        public_router: http::public_router(PublicAuthState {
            refresh,
            login,
            register,
        }),
    }
}
