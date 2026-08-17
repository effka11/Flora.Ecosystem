//! Модуль Messaging. Перенос — Фаза 4, вместе с Notifications (next-architecture.md §6).
//! Перед правками E2E-поверхности обязателен skill `/flora-fscp-e2e`; владелец — таблица §6.0.
//!
//! FSCP wire validation — functional product `Products/FSCP` (`fscp_core`).
//! HTTP: unread-count + conversations + messages + assets + E2E + legacy `/api/auth/conversations*`/`messages*` + e2e-public-key при `Messaging:ServeNative=true`.

pub mod application;
pub mod http;
pub mod infrastructure;
pub mod password_reset_hook;

use std::sync::Arc;

use flora_auth_contracts::AccountDirectory;
use flora_messaging_contracts::{
    MessageReadNotifier, MessageSentNotifier, MessageTypingNotifier, PushPreviewTargetProvider,
};
use flora_users_contracts::{FeedAuthorProfiles, MessagesAccess, OnlineStatusAccess, UserPresence};
use sqlx::PgPool;

use crate::application::{
    AssetService, ChatListService, ConversationService, E2eEpochService, E2eKeyBackupService,
    FrankingService, FrankingSigner, GroupService, parse_franking_seed, parse_reviewer_uuids,
};
use crate::http::MessagingState;
use crate::infrastructure::{ChatListRepo, E2eProofTokens, FrankingRepo, GroupRepo, MessagingRepo};

/// Re-export FSCP validator for callers that historically used `flora_messaging::fscp`.
pub use fscp_core as fscp;
pub use password_reset_hook::password_reset_hook;

/// Wiring-only: seed и allowlist ревьюеров из конфига хоста. Людей в коде нет.
#[derive(Clone, Default)]
pub struct FrankingHostConfig {
    pub signing_seed: Option<String>,
    pub reviewer_user_uuids: Vec<String>,
}

impl std::fmt::Debug for FrankingHostConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FrankingHostConfig")
            .field(
                "signing_seed",
                &self.signing_seed.as_ref().map(|_| "<redacted>"),
            )
            .field("reviewer_user_uuids", &self.reviewer_user_uuids)
            .finish()
    }
}

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
    typing_notifier: Arc<dyn MessageTypingNotifier>,
    read_notifier: Arc<dyn MessageReadNotifier>,
    preview_targets: Arc<dyn PushPreviewTargetProvider>,
    e2e_token_secret: Option<Vec<u8>>,
    franking_host: FrankingHostConfig,
) -> MessagingModule {
    let cleanup_pool = pool.clone();
    let repo = Arc::new(MessagingRepo::new(pool.clone()));
    let group_repo = Arc::new(GroupRepo::new(pool.clone()));
    let chat_list = Arc::new(ChatListService::new(Arc::new(ChatListRepo::new(
        pool.clone(),
    ))));
    let signer = match franking_host
        .signing_seed
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        None => None,
        Some(raw) => match parse_franking_seed(raw) {
            Some(seed) => Some(Arc::new(FrankingSigner::from_seed(seed))),
            None => {
                tracing::error!(
                    "flora-messaging: Messaging:FrankingSigningSeed невалиден — tagged send fail-closed"
                );
                None
            }
        },
    };
    if signer.is_none() {
        tracing::warn!(
            "flora-messaging: нет валидного Messaging:FrankingSigningSeed — untagged send работает, tagged — messaging.franking.signing_unavailable"
        );
    }
    let franking = Arc::new(FrankingService::new(
        Arc::new(FrankingRepo::new(pool.clone())),
        signer,
    ));
    merge_reviewers_at_start(&franking, &franking_host.reviewer_user_uuids.join(","));
    let conversations = Arc::new(ConversationService::new(
        repo.clone(),
        accounts.clone(),
        profiles.clone(),
        presence,
        online_access,
        messages_access.clone(),
        sent_notifier.clone(),
        typing_notifier,
        read_notifier,
        preview_targets,
        franking.clone(),
    ));
    // Errata-5: HMAC-подписанные proof-токены recovery/approve. None → fail-closed
    // (выдача отключена, unlock-complete отклоняет любые токены).
    let proof_tokens = Arc::new(E2eProofTokens::new(e2e_token_secret));
    if !proof_tokens.is_enabled() {
        tracing::warn!(
            "flora-messaging: E2E proof-токены отключены (нет Messaging:E2eTokenSecret и Jwt:Secret) — unlock-complete будет отклонять запросы"
        );
    }
    let assets = Arc::new(AssetService::new(
        pool.clone(),
        accounts.clone(),
        messages_access.clone(),
    ));
    let e2e = Arc::new(E2eKeyBackupService::new(pool.clone(), proof_tokens.clone()));
    let epochs = Arc::new(E2eEpochService::new(pool, proof_tokens));
    let groups = Arc::new(GroupService::new(
        group_repo,
        repo,
        accounts,
        profiles,
        messages_access,
        e2e.clone(),
        sent_notifier,
    ));
    MessagingModule {
        router: http::protected_router(MessagingState {
            conversations,
            groups,
            chat_list,
            assets,
            e2e,
            epochs,
            franking,
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

/// Allowlist из хоста должен быть в `franking_reviewers` до первого JWT-запроса.
/// `compose` синхронный и вызывается из async `flora-api::build_host` — `block_in_place`,
/// иначе `block_on` на worker-треде tokio дедлочит.
fn merge_reviewers_at_start(franking: &FrankingService, raw_allowlist: &str) {
    let reviewers = match parse_reviewer_uuids(raw_allowlist) {
        Ok(uuids) => uuids,
        Err(error) => {
            tracing::error!(
                %error,
                "flora-messaging: allowlist ревьюеров невалиден — очередь не выдаётся как пустой roster"
            );
            franking.mark_reviewer_roster_unready();
            return;
        }
    };
    if reviewers.is_empty() {
        return;
    }
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        tracing::error!(
            "flora-messaging: нет tokio runtime — franking_reviewers из конфига не смержены"
        );
        franking.mark_reviewer_roster_unready();
        return;
    };
    let result =
        tokio::task::block_in_place(|| handle.block_on(franking.merge_reviewers(&reviewers)));
    if let Err(error) = result {
        tracing::error!(
            %error,
            "flora-messaging: merge franking_reviewers не удался — allowlist из конфига не в БД"
        );
        franking.mark_reviewer_roster_unready();
    }
}
