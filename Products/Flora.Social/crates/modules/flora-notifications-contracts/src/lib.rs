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

/// Cross-module port: insert inbox row + SSE `event: notification` (+ FCM).
/// Implemented by Notifications; Content/Users must not touch `user_notifications`.
pub trait UserNotificationDispatcher: Send + Sync {
    fn dispatch(
        &self,
        command: CreateUserNotificationCommand,
    ) -> BoxFuture<'_, Result<(), String>>;
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
}
