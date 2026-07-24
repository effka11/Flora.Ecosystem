//! Модуль Auth. Фаза 2b: JWT с Фазы 0; HTTP — по срезам (`Auth:ServeNative`).

pub mod application;
pub mod domain;
pub mod http;
pub mod infrastructure;

use std::sync::Arc;

use flora_users_contracts::{UserProfileProvisioner, UserProfileReadQueries};
use flora_verification_contracts::VerificationChallengePort;
use sqlx::PgPool;

use crate::application::account::AccountService;
use crate::application::login::LoginService;
use crate::application::refresh::{RefreshService, ReplayConfig};
use crate::application::register::RegisterService;
use crate::application::replay_cleanup::{ReplayCleanupConfig, spawn_replay_cleanup};
use crate::application::security::SecurityService;
use crate::application::sessions::SessionService;
use crate::http::{AuthState, PublicAuthState};
use crate::infrastructure::jwt::JwtOptions;
use crate::infrastructure::repo::AuthRepo;

/// Rust-миграции модуля Auth (регистрируются в flora-migrate, §11.1). Additive
/// replay-grant таблица для retry-safe refresh (plan §2).
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// Хэндл фоновой Auth-задачи (abort при shutdown хоста).
pub type WorkerHandle = tokio::task::JoinHandle<()>;

/// Собранный модуль Auth (нативные маршруты при ServeNative).
pub struct AuthModule {
    /// JWT-защищённые маршруты.
    pub protected_router: axum::Router,
    /// Анонимные (login/refresh/register/verify/cancel).
    pub public_router: axum::Router,
    /// Порт каталога аккаунтов для Users.
    pub account_directory: Arc<dyn flora_auth_contracts::AccountDirectory>,
    /// Периодическая очистка истёкших replay-строк. `Some` только когда retry-safe
    /// refresh включён; при legacy-режиме `None` (джоба не спавнится).
    pub replay_cleanup: Option<WorkerHandle>,
}

/// Пустой роутер — gateway-fallback на .NET.
pub fn router() -> axum::Router {
    axum::Router::new()
}

/// Композиция с legacy refresh (replay-протокол выключен). Совместимо со старой
/// сигнатурой; продукт (flora-social) продолжает вызывать её как есть.
pub fn compose(
    pool: PgPool,
    jwt: JwtOptions,
    profiles: Arc<dyn UserProfileReadQueries>,
    provisioner: Arc<dyn UserProfileProvisioner>,
    verification: Arc<dyn VerificationChallengePort>,
) -> AuthModule {
    compose_with_replay(pool, jwt, profiles, provisioner, verification, None)
}

/// Композиция с опциональным retry-safe replay-протоколом. `replay = Some(..)`
/// включает транзакционную ротацию с grace-барьером; `None` — legacy.
/// Собирается из конфигурации через [`ReplayConfig::from_config`] на стороне
/// продукта (staged rollout: сначала `None`, затем `Some`).
pub fn compose_with_replay(
    pool: PgPool,
    jwt: JwtOptions,
    profiles: Arc<dyn UserProfileReadQueries>,
    provisioner: Arc<dyn UserProfileProvisioner>,
    verification: Arc<dyn VerificationChallengePort>,
    replay: Option<ReplayConfig>,
) -> AuthModule {
    let repo = Arc::new(AuthRepo::new(pool));
    let sessions = Arc::new(SessionService::new(repo.clone()));
    let security = Arc::new(SecurityService::new(repo.clone(), verification.clone()));
    let account = Arc::new(AccountService::new(repo.clone()));
    // Cleanup-джоба спавнится только при включённом replay-протоколе.
    let replay_cleanup = replay
        .as_ref()
        .map(|_| spawn_replay_cleanup(repo.clone(), ReplayCleanupConfig::default()));
    let refresh = Arc::new(RefreshService::with_replay(
        repo.clone(),
        jwt.clone(),
        profiles.clone(),
        replay,
    ));
    let login = Arc::new(LoginService::new(
        repo.clone(),
        jwt.clone(),
        profiles.clone(),
    ));
    let register = Arc::new(RegisterService::new(
        repo.clone(),
        jwt,
        verification,
        profiles,
        provisioner,
    ));
    let account_directory = infrastructure::account_directory::as_directory(repo);
    AuthModule {
        protected_router: http::protected_router(AuthState {
            sessions,
            security,
            account,
        }),
        public_router: http::public_router(PublicAuthState {
            refresh,
            login,
            register,
        }),
        account_directory,
        replay_cleanup,
    }
}

/// Каталог аккаунтов без полного Auth compose (Users/Content ServeNative).
pub fn account_directory(pool: PgPool) -> Arc<dyn flora_auth_contracts::AccountDirectory> {
    let repo = Arc::new(AuthRepo::new(pool));
    infrastructure::account_directory::as_directory(repo)
}

/// Проверка активной сессии без полного Auth compose.
pub fn access_session_validator(
    pool: PgPool,
) -> Arc<dyn flora_auth_contracts::AccessSessionValidator> {
    let repo = Arc::new(AuthRepo::new(pool));
    infrastructure::session_validator::as_validator(repo)
}
