//! Модуль Users. Перенос — Фаза 2b, вместе с Auth (next-architecture.md §6); владелец — §6.0.
//!
//! Уже перенесено: FIRA-P scorer; порты profile read/provisioner для Auth.

pub mod application;
pub mod infrastructure;

use std::sync::Arc;

use sqlx::PgPool;

use crate::infrastructure::profile_reads::SqlUserProfileQueries;

pub fn router() -> axum::Router {
    axum::Router::new()
}

/// Порты Users для Auth (один sqlx-адаптер реализует read + provisioner).
pub fn profile_ports(
    pool: PgPool,
) -> (
    Arc<dyn flora_users_contracts::UserProfileReadQueries>,
    Arc<dyn flora_users_contracts::UserProfileProvisioner>,
) {
    let q = Arc::new(SqlUserProfileQueries::new(pool));
    (q.clone(), q)
}

/// Обратная совместимость со срезом refresh/login.
pub fn profile_read_queries(pool: PgPool) -> Arc<dyn flora_users_contracts::UserProfileReadQueries> {
    profile_ports(pool).0
}
