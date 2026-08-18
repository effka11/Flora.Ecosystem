//! Модуль Chat Organizer (FSCP-ORG v1): opaque blob store.
//!
//! HTTP монтируется продуктом только при `ChatOrganizer:ServeNative=true`.

pub mod application;
pub mod http;
pub mod infrastructure;

use std::sync::Arc;

use flora_users_contracts::AccountSanctionStatus;
use sqlx::PgPool;

use crate::application::OrganizerService;
use crate::http::OrganizerState;
use crate::infrastructure::OrganizerRepo;

/// Rust-миграции модуля (регистрируются в flora-migrate).
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// Собранный модуль: роутер с state (без JWT — слой навешивает flora-social).
pub struct ChatOrganizerModule {
    pub router: axum::Router,
}

/// Пустой роутер (ServeNative=false / нет пула).
pub fn router() -> axum::Router {
    axum::Router::new()
}

pub fn compose(
    pool: PgPool,
    account_status: Arc<dyn AccountSanctionStatus>,
) -> ChatOrganizerModule {
    let repo = Arc::new(OrganizerRepo::new(pool));
    let organizer = Arc::new(OrganizerService::new(repo));
    ChatOrganizerModule {
        router: http::router(OrganizerState { organizer }, account_status),
    }
}
