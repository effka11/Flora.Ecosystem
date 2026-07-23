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
use flora_messaging_contracts::{MessageSentNotifier, PushPreviewTargetProvider};
use flora_users_contracts::{FeedAuthorProfiles, MessagesAccess, OnlineStatusAccess, UserPresence};
use sqlx::PgPool;

use crate::application::{AssetService, ConversationService, E2eEpochService, E2eKeyBackupService};
use crate::http::MessagingState;
use crate::infrastructure::{E2eProofTokens, MessagingRepo};

/// Re-export FSCP validator for callers that historically used `flora_messaging::fscp`.
pub use fscp_core as fscp;

/// Rust-миграции модуля Messaging (первые после cutover; применяются flora-migrate
/// в таблицу истории `__flora_migrations_messaging`, next-architecture.md §11.1).
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!();

/// Собранный модуль: защищённый роутер (JWT навешивает flora-social).
pub struct MessagingModule {
    pub router: axum::Router,
    pub asset_cleanup: tokio::task::JoinHandle<()>,
}

/// Пустой роутер (ServeNative=false / нет пула) — gateway-fallback отдаёт в .NET.
pub fn router() -> axum::Router {
    axum::Router::new()
}

#[allow(clippy::too_many_arguments)]
pub fn compose(
    pool: PgPool,
    accounts: Arc<dyn AccountDirectory>,
    profiles: Arc<dyn FeedAuthorProfiles>,
    presence: Arc<dyn UserPresence>,
    online_access: Arc<dyn OnlineStatusAccess>,
    messages_access: Arc<dyn MessagesAccess>,
    sent_notifier: Arc<dyn MessageSentNotifier>,
    preview_targets: Arc<dyn PushPreviewTargetProvider>,
    e2e_token_secret: Option<Vec<u8>>,
) -> MessagingModule {
    let cleanup_pool = pool.clone();
    let repo = Arc::new(MessagingRepo::new(pool.clone()));
    let conversations = Arc::new(ConversationService::new(
        repo,
        accounts.clone(),
        profiles,
        presence,
        online_access,
        messages_access.clone(),
        sent_notifier,
        preview_targets,
    ));
    // Errata-5: HMAC-подписанные proof-токены recovery/approve. None → fail-closed
    // (выдача отключена, unlock-complete отклоняет любые токены).
    let proof_tokens = Arc::new(E2eProofTokens::new(e2e_token_secret));
    if !proof_tokens.is_enabled() {
        tracing::warn!(
            "flora-messaging: E2E proof-токены отключены (нет Messaging:E2eTokenSecret и Jwt:Secret) — unlock-complete будет отклонять запросы"
        );
    }
    let assets = Arc::new(AssetService::new(pool.clone(), accounts, messages_access));
    let e2e = Arc::new(E2eKeyBackupService::new(pool.clone(), proof_tokens.clone()));
    let epochs = Arc::new(E2eEpochService::new(pool, proof_tokens));
    MessagingModule {
        router: http::protected_router(MessagingState {
            conversations,
            assets,
            e2e,
            epochs,
        }),
        asset_cleanup: tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(6 * 60 * 60));
            loop {
                interval.tick().await;
                let threshold = chrono::Utc::now() - chrono::Duration::hours(24);
                match infrastructure::delete_stale_unbound_image_assets(&cleanup_pool, threshold)
                    .await
                {
                    Ok(removed) if removed > 0 => {
                        tracing::info!(removed, "removed stale unbound message image assets");
                    }
                    Ok(_) => {}
                    Err(error) => {
                        tracing::warn!(%error, "message image asset cleanup failed");
                    }
                }
            }
        }),
    }
}
