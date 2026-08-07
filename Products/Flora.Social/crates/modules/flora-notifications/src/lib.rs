//! Модуль Notifications. Перенос — Фаза 4 (next-architecture.md §6);
//! владелец — таблица §6.0. SSE-инварианты — §4.6.
//!
//! ServeNative HTTP: inbox list/unread + mark-read + delete + push-token + SSE stream
//! + admin broadcast (`POST /api/admin/notifications/broadcast`, `X-Flora-Admin-Token`).
//!   After Messaging send: SSE `event: message` + FCM push (паритет UserRealtimePublisher).
//!   Legacy inbox create (`dispatch`): Content/Users → INSERT + SSE `event: notification` + FCM
//!   (reply / developer / app_update and other non-aggregated types).
//!   Social like/repost/follow (`apply_social` / `retract_social`): one inbox row per canonical
//!   `group_key` (`like` / `repost` / `follow`), Model B text, TikTok-style 15m audible budget
//!   (`social_notification_push_state` claimed under the group lock before FCM), quiet-replace on
//!   partial retract, empty group → DELETE + SSE `event: notification_removed` + data-only FCM
//!   `notification_dismiss`. Same actor on another post refreshes `post_uuid` only (no FCM).

pub mod application;
pub mod http;
pub mod infrastructure;

use std::sync::Arc;

use flora_auth_contracts::AccountDirectory;
use flora_messaging_contracts::{
    MessageReadNotifier, MessageSentNotifier, MessageTypingNotifier, PushPreviewTargetProvider,
};
use flora_notifications_contracts::{PresenceRealtimePublisher, UserNotificationDispatcher};
use flora_shared::config::FloraConfig;
use flora_users_contracts::UserProfileQueries;
use sqlx::PgPool;

use crate::application::{
    HubPresencePublisher, HubReadNotifier, HubTypingNotifier, InboxNotificationDispatcher,
    InboxService, MessagePushNotifier, PushTokenService, UserRealtimePublisher,
};
use crate::http::{
    AdminBroadcastRateLimiter, AdminBroadcastState, NotificationsState, admin_router,
    protected_router,
};
use crate::infrastructure::{
    ApnsPushSender, ClientPlatformRepo, FcmPushSender, InboxRepo, PushTokenRepo,
    UserDisplayNameResolver, UserRealtimeHub,
};

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!();

/// Собранный модуль: protected (JWT) + admin (token header) + порты Messaging/Content/Users.
pub struct NotificationsModule {
    pub protected_router: axum::Router,
    /// Без JWT — `X-Flora-Admin-Token`.
    pub admin_router: axum::Router,
    /// Реализация `IMessageSentNotifier` — SSE + FCM после DM.
    pub message_sent_notifier: Arc<dyn MessageSentNotifier>,
    pub message_typing_notifier: Arc<dyn MessageTypingNotifier>,
    pub message_read_notifier: Arc<dyn MessageReadNotifier>,
    pub push_preview_targets: Arc<dyn PushPreviewTargetProvider>,
    /// Реализация `DispatchAsync` — inbox row + SSE `event: notification`.
    pub user_notification_dispatcher: Arc<dyn UserNotificationDispatcher>,
    pub presence_publisher: Arc<dyn PresenceRealtimePublisher>,
    pub hub: Arc<UserRealtimeHub>,
}

/// Пустой роутер (ServeNative=false / нет пула) — gateway-fallback на .NET.
pub fn router() -> axum::Router {
    axum::Router::new()
}

pub fn compose(
    pool: PgPool,
    cfg: &FloraConfig,
    profiles: Arc<dyn UserProfileQueries>,
    accounts: Arc<dyn AccountDirectory>,
) -> NotificationsModule {
    let hub = Arc::new(UserRealtimeHub::new());
    let inbox_repo = Arc::new(InboxRepo::new(pool.clone()));
    let push_repo = Arc::new(PushTokenRepo::new(pool.clone()));
    let client_platforms = Arc::new(ClientPlatformRepo::new(pool));
    let push_tokens = Arc::new(PushTokenService::new(
        Arc::clone(&push_repo),
        cfg.get_bool("Push:SecurePreview:AndroidEnabled") != Some(false),
        cfg.get_bool("Push:SecurePreview:IosEnabled") != Some(false),
    ));
    let fcm = Arc::new(FcmPushSender::from_config(cfg, Arc::clone(&push_repo)));
    let apns = Arc::new(ApnsPushSender::from_config(cfg, Arc::clone(&push_repo)));
    let display_names = Arc::new(UserDisplayNameResolver::new(
        profiles,
        Arc::clone(&accounts),
    ));
    let realtime = Arc::new(UserRealtimePublisher::new(
        Arc::clone(&hub),
        Arc::clone(&push_tokens),
        fcm,
        apns,
        display_names,
    ));
    let inbox = Arc::new(InboxService::new(
        Arc::clone(&inbox_repo),
        Arc::clone(&accounts),
        client_platforms,
        Arc::clone(&push_tokens),
        Arc::clone(&realtime),
    ));
    let message_sent_notifier: Arc<dyn MessageSentNotifier> =
        Arc::new(MessagePushNotifier::new(Arc::clone(&realtime)));
    let message_typing_notifier: Arc<dyn MessageTypingNotifier> =
        Arc::new(HubTypingNotifier::new(Arc::clone(&hub)));
    let message_read_notifier: Arc<dyn MessageReadNotifier> =
        Arc::new(HubReadNotifier::new(Arc::clone(&hub)));
    let presence_publisher: Arc<dyn PresenceRealtimePublisher> =
        Arc::new(HubPresencePublisher::new(Arc::clone(&hub)));
    let push_preview_targets: Arc<dyn PushPreviewTargetProvider> = push_tokens.clone();
    let user_notification_dispatcher: Arc<dyn UserNotificationDispatcher> =
        Arc::new(InboxNotificationDispatcher::new(inbox_repo, realtime));

    let configured_admin_token = cfg
        .get_non_empty("Flora:AdminBroadcastToken")
        .map(|s| Arc::<str>::from(s.to_string()));
    let admin_token = configured_admin_token.filter(|token| {
        let lowered = token.to_ascii_lowercase();
        let placeholder = ["change_me", "change-me", "changeme", "placeholder"]
            .iter()
            .any(|fragment| lowered.contains(fragment));
        let enough_diversity = token
            .chars()
            .collect::<std::collections::HashSet<_>>()
            .len()
            >= 8;
        if token.len() >= 32 && enough_diversity && !placeholder {
            true
        } else {
            tracing::error!(
                "Flora:AdminBroadcastToken слабый или является плейсхолдером — admin endpoint отключён"
            );
            false
        }
    });

    NotificationsModule {
        protected_router: protected_router(NotificationsState {
            inbox: Arc::clone(&inbox),
            push_tokens,
            hub: Arc::clone(&hub),
        }),
        admin_router: admin_router(AdminBroadcastState {
            inbox,
            admin_token,
            rate_limiter: Arc::new(AdminBroadcastRateLimiter::new()),
        }),
        message_sent_notifier,
        message_typing_notifier,
        message_read_notifier,
        push_preview_targets,
        user_notification_dispatcher,
        presence_publisher,
        hub,
    }
}
