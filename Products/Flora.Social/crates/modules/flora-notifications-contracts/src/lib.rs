//! Контракты модуля Notifications — DTO и trait-порты без бизнес-логики (next-architecture.md §2.2).
//!
//! Realtime SSE payloads — паритет `RealtimeContracts.cs`. Чужим модулям разрешена
//! зависимость только от этого crate (§2.3).

use std::future::Future;
use std::pin::Pin;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// SSE `event: message` payload (C# `RealtimeMessageSignal`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeMessageSignal {
    pub conversation_uuid: Uuid,
    pub sender_user_uuid: Uuid,
    pub sent_at: DateTime<Utc>,
    /// Optional client hint: `"dm"` | `"groupChat"`. Absent on older servers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// Sideload APK update metadata carried on FCM/SSE for `app_update` (not stored in DB).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdatePayload {
    pub version: String,
    pub version_code: i64,
    pub apk_url: String,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<i64>,
}

/// SSE `event: notification` payload (C# `RealtimeNotificationSignal`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeNotificationSignal {
    pub notification_uuid: Uuid,
    #[serde(rename = "type")]
    pub notification_type: String,
    pub category: String,
    pub text: String,
    pub actor_user_uuid: Option<Uuid>,
    pub post_uuid: Option<Uuid>,
    pub comment_uuid: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    /// Present for `app_update` broadcasts when the admin supplied a manifest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<AppUpdatePayload>,
}

/// Паритет `CreateUserNotificationCommand` (C# NotificationContracts).
#[derive(Debug, Clone)]
pub struct CreateUserNotificationCommand {
    pub recipient_user_uuid: Uuid,
    pub actor_user_uuid: Option<Uuid>,
    pub notification_type: String,
    pub category: String,
    pub text: String,
    pub post_uuid: Option<Uuid>,
    pub comment_uuid: Option<Uuid>,
}

/// Kind of social activity that Notifications may apply or retract.
#[derive(Debug, Clone)]
pub enum SocialActivityKind {
    Like { post_uuid: Uuid },
    Repost { post_uuid: Uuid },
    Follow,
}

/// Cross-module command: apply or retract a social activity notification.
#[derive(Debug, Clone)]
pub struct SocialActivityCommand {
    pub recipient_user_uuid: Uuid,
    pub actor_user_uuid: Uuid,
    pub actor_label: String,
    pub kind: SocialActivityKind,
}

/// SSE `event: notification_removed` payload when a social notification group is deleted.
///
/// Intentional additive realtime surface (plan: social notifications reliability):
/// inbox REST DTO shape unchanged; clients must ignore unknown SSE events until upgraded.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeNotificationRemovedSignal {
    pub notification_uuid: Uuid,
    /// Nullable contract field — always serialize `null` (§4.3); never `skip_serializing_if`.
    #[serde(default)]
    pub group_key: Option<String>,
}

/// SSE `event: presence` — online/offline transition for a watched user.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimePresenceSignal {
    pub user_uuid: Uuid,
    pub is_online: bool,
    pub last_seen_at: Option<DateTime<Utc>>,
}

/// SSE `event: typing` — DM compose activity (no FCM).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeTypingSignal {
    pub conversation_uuid: Uuid,
    pub user_uuid: Uuid,
    pub is_typing: bool,
}

/// SSE `event: read` — conversation marked read by peer (no FCM).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeReadSignal {
    pub conversation_uuid: Uuid,
    pub reader_user_uuid: Uuid,
}

/// SSE `event: connected` — first frame after subscribe.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeConnectedSignal {
    pub connection_id: Uuid,
}

/// Cross-module port: insert inbox row + SSE `event: notification` (+ FCM).
/// Implemented by Notifications; Content/Users must not touch `user_notifications`.
pub trait UserNotificationDispatcher: Send + Sync {
    fn dispatch(&self, command: CreateUserNotificationCommand)
    -> BoxFuture<'_, Result<(), String>>;

    fn apply_social(&self, command: SocialActivityCommand) -> BoxFuture<'_, Result<(), String>>;

    fn retract_social(&self, command: SocialActivityCommand) -> BoxFuture<'_, Result<(), String>>;
}

/// Publish presence SSE to a specific watcher SSE connection.
pub trait PresenceRealtimePublisher: Send + Sync {
    fn publish_to_connection(
        &self,
        recipient_user_uuid: Uuid,
        connection_id: Uuid,
        signal: &RealtimePresenceSignal,
    );
}

/// No-op when Notifications ServeNative is off.
pub struct NoopPresenceRealtimePublisher;

impl PresenceRealtimePublisher for NoopPresenceRealtimePublisher {
    fn publish_to_connection(
        &self,
        _recipient_user_uuid: Uuid,
        _connection_id: Uuid,
        _signal: &RealtimePresenceSignal,
    ) {
    }
}

/// Hooks for SSE connection lifecycle (wired in flora-social → PresenceService).
pub trait SseConnectionHooks: Send + Sync {
    fn on_subscribe(&self, user_uuid: Uuid, connection_id: Uuid);
    fn on_unsubscribe(&self, user_uuid: Uuid, connection_id: Uuid);
}

pub struct NoopSseConnectionHooks;

impl SseConnectionHooks for NoopSseConnectionHooks {
    fn on_subscribe(&self, _user_uuid: Uuid, _connection_id: Uuid) {}
    fn on_unsubscribe(&self, _user_uuid: Uuid, _connection_id: Uuid) {}
}

/// No-op when Notifications ServeNative is off.
pub struct NoopUserNotificationDispatcher;

impl UserNotificationDispatcher for NoopUserNotificationDispatcher {
    fn dispatch(
        &self,
        _command: CreateUserNotificationCommand,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn apply_social(&self, _command: SocialActivityCommand) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn retract_social(&self, _command: SocialActivityCommand) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}
