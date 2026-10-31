//! Модуль Auth. Фаза 2b: JWT с Фазы 0; HTTP — по срезам (`Auth:ServeNative`).

pub mod application;
pub mod domain;
pub mod http;
pub mod infrastructure;

use std::sync::Arc;

use flora_auth_contracts::PasswordResetHook;
use flora_users_contracts::{UserProfileProvisioner, UserProfileReadQueries};
use flora_verification_contracts::VerificationChallengePort;
use sqlx::PgPool;

use crate::application::account::AccountService;
use crate::application::login::LoginService;
use crate::application::password_reset::PasswordResetService;
use crate::application::refresh::{RefreshService, ReplayConfig};
use crate::application::register::RegisterService;
use crate::application::replay_cleanup::{ReplayCleanupConfig, spawn_replay_cleanup};
use crate::application::security::SecurityService;
use crate::application::sessions::SessionService;
use crate::application::totp_reseal::{TotpResealConfig, spawn_totp_reseal};
use crate::http::{AuthState, PublicAuthState};
use crate::infrastructure::jwt::JwtOptions;
use crate::infrastructure::repo::AuthRepo;
use crate::infrastructure::totp_at_rest::TotpAtRest;

/// Rust-миграции модуля Auth (регистрируются в flora-migrate, §11.1). Additive
/// replay-grant таблица для retry-safe refresh (plan §2).
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// Хэндл фоновой Auth-задачи (abort при shutdown хоста).
pub type WorkerHandle = tokio::task::JoinHandle<()>;

/// Собранный модуль Auth (нативные маршруты при ServeNative).
pub struct AuthModule {
    /// JWT-защищённые маршруты.
    pub protected_router: axum::Router,
    /// Анонимные (login/refresh/register/verify/cancel/password-reset).
    pub public_router: axum::Router,
    /// Порт каталога аккаунтов для Users.
    pub account_directory: Arc<dyn flora_auth_contracts::AccountDirectory>,
    /// Фоновые Auth-задачи: cleanup истёкших replay-строк (только при retry-safe
    /// refresh) и бэкфилл/ротация sealed TOTP-секретов (только в sealed-режиме).
    /// Хост abort-ит их при shutdown.
    pub background: Vec<WorkerHandle>,
}

/// Пустой роутер — gateway-fallback на .NET.
pub fn router() -> axum::Router {
    axum::Router::new()
}

/// Композиция с legacy refresh (replay-протокол выключен).
pub fn compose(
    pool: PgPool,
    jwt: JwtOptions,
    totp_at_rest: TotpAtRest,
    profiles: Arc<dyn UserProfileReadQueries>,
    provisioner: Arc<dyn UserProfileProvisioner>,
    verification: Arc<dyn VerificationChallengePort>,
    password_reset_hook: Option<Arc<dyn PasswordResetHook>>,
) -> AuthModule {
    compose_with_replay(
        pool,
        jwt,
        totp_at_rest,
        profiles,
        provisioner,
        verification,
        None,
        password_reset_hook,
    )
}

/// Композиция с опциональным retry-safe replay-протоколом.
// Точка сборки модуля: параметры — порты и конфигурация, которые раздаются внутрь
// сервисов как есть; сокрытие их в структуру не даёт выигрыша в безопасности границ.
#[allow(clippy::too_many_arguments)]
pub fn compose_with_replay(
    pool: PgPool,
    jwt: JwtOptions,
    totp_at_rest: TotpAtRest,
    profiles: Arc<dyn UserProfileReadQueries>,
    provisioner: Arc<dyn UserProfileProvisioner>,
    verification: Arc<dyn VerificationChallengePort>,
    replay: Option<ReplayConfig>,
    password_reset_hook: Option<Arc<dyn PasswordResetHook>>,
) -> AuthModule {
    let repo = Arc::new(AuthRepo::new(pool));
    let totp_at_rest = Arc::new(totp_at_rest);
    let sessions = Arc::new(SessionService::new(repo.clone()));
    let security = Arc::new(SecurityService::new(
        repo.clone(),
        verification.clone(),
        totp_at_rest.clone(),
    ));
    let account = Arc::new(AccountService::new(repo.clone(), provisioner.clone()));
    let mut background = Vec::new();
    if replay.is_some() {
        background.push(spawn_replay_cleanup(
            repo.clone(),
            ReplayCleanupConfig::default(),
        ));
    }
    if totp_at_rest.is_sealed() {
        background.push(spawn_totp_reseal(
            repo.clone(),
            totp_at_rest.clone(),
            TotpResealConfig::default(),
        ));
    }
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
        totp_at_rest,
    ));
    let password_reset = Arc::new(PasswordResetService::new(
        repo.clone(),
        verification.clone(),
        password_reset_hook,
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
            password_reset,
        }),
        account_directory,
        background,
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
