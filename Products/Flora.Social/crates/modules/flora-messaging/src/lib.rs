//! Модуль Messaging. Перенос — Фаза 4, вместе с Notifications (next-architecture.md §6).
//! Перед правками E2E-поверхности обязателен skill `/flora-fscp-e2e`; владелец — таблица §6.0.
//!
//! FSCP wire validation — functional product `Products/FSCP` (`fscp_core`).
//! HTTP: unread-count + conversations + messages + assets + E2E + legacy `/api/auth/conversations*`/`messages*` + e2e-public-key при `Messaging:ServeNative=true`.

pub mod application;
pub mod http;
pub mod infrastructure;

use std::sync::Arc;

use flora_auth_contracts::AccountDirectory;
use flora_messaging_contracts::MessageSentNotifier;
use flora_users_contracts::{FeedAuthorProfiles, MessagesAccess, OnlineStatusAccess, UserPresence};
use sqlx::PgPool;

use crate::application::{AssetService, ConversationService, E2eEpochService, E2eKeyBackupService};
use crate::http::MessagingState;
use crate::infrastructure::MessagingRepo;

/// Re-export FSCP validator for callers that historically used `flora_messaging::fscp`.
pub use fscp_core as fscp;

/// Собранный модуль: защищённый роутер (JWT навешивает flora-social).
pub struct MessagingModule {
    pub router: axum::Router,
}

/// Пустой роутер (ServeNative=false / нет пула) — gateway-fallback отдаёт в .NET.
pub fn router() -> axum::Router {
    axum::Router::new()
}

pub fn compose(
    pool: PgPool,
    accounts: Arc<dyn AccountDirectory>,
    profiles: Arc<dyn FeedAuthorProfiles>,
    presence: Arc<dyn UserPresence>,
    online_access: Arc<dyn OnlineStatusAccess>,
    messages_access: Arc<dyn MessagesAccess>,
    sent_notifier: Arc<dyn MessageSentNotifier>,
) -> MessagingModule {
    let repo = Arc::new(MessagingRepo::new(pool.clone()));
    let conversations = Arc::new(ConversationService::new(
        repo,
        accounts.clone(),
        profiles,
        presence,
        online_access,
        messages_access,
        sent_notifier,
    ));
    let assets = Arc::new(AssetService::new(pool.clone(), accounts));
    let e2e = Arc::new(E2eKeyBackupService::new(pool.clone()));
    let epochs = Arc::new(E2eEpochService::new(pool));
    MessagingModule {
        router: http::protected_router(MessagingState {
            conversations,
            assets,
            e2e,
            epochs,
        }),
    }
}
