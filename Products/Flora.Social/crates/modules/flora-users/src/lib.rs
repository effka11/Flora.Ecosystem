//! Модуль Users. Перенос — Фаза 2b, вместе с Auth (next-architecture.md §6); владелец — §6.0.
//!
//! Уже перенесено (до cutover, паритет закреплён golden-вектором `fira-p-scorer-v1.json`):
//! чистый скорер FIRA-P — [`application::people`].
//! Порт `UserProfileReadQueries` — для Auth refresh/login (`requires_profile_completion`).

pub mod application;
pub mod infrastructure;

use std::sync::Arc;

use sqlx::PgPool;

use crate::infrastructure::profile_reads::SqlUserProfileReadQueries;

/// HTTP-роутер модуля (профили/аватары/подписки/поиск). До cutover Фазы 2b пуст —
/// запросы обслуживает C#-хост через gateway-fallback.
pub fn router() -> axum::Router {
    axum::Router::new()
}

/// Порт чтения профиля для чужих модулей (Auth) — sqlx по `user_profiles`.
pub fn profile_read_queries(pool: PgPool) -> Arc<dyn flora_users_contracts::UserProfileReadQueries> {
    Arc::new(SqlUserProfileReadQueries::new(pool))
}
