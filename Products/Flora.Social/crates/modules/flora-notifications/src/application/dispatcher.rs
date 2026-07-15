//! Inbox `DispatchAsync` — insert `user_notifications` + SSE/FCM (паритет C#).

use std::sync::Arc;

use chrono::Utc;
use flora_notifications_contracts::{
    BoxFuture, CreateUserNotificationCommand, RealtimeNotificationSignal,
    UserNotificationDispatcher,
};
use flora_shared::flora_uuid::new_uuid;

use crate::application::UserRealtimePublisher;
use crate::application::platform::{normalize_category, normalize_type};
use crate::infrastructure::InboxRepo;

pub struct InboxNotificationDispatcher {
    repo: Arc<InboxRepo>,
    realtime: Arc<UserRealtimePublisher>,
}

impl InboxNotificationDispatcher {
    pub fn new(repo: Arc<InboxRepo>, realtime: Arc<UserRealtimePublisher>) -> Self {
        Self { repo, realtime }
    }

    async fn dispatch_inner(&self, command: CreateUserNotificationCommand) -> Result<(), String> {
        if command.recipient_user_uuid.is_nil() {
            return Ok(());
        }
        if let Some(actor) = command.actor_user_uuid
            && actor == command.recipient_user_uuid
        {
            return Ok(());
        }

        let text = command.text.trim();
        if text.is_empty() {
            return Ok(());
        }
        let text = if text.chars().count() <= 500 {
            text.to_string()
        } else {
            text.chars().take(500).collect()
        };

        let notification_type = normalize_type(&command.notification_type);
        let category = normalize_category(&command.category);
        let notification_uuid = new_uuid();
        let created_at = Utc::now();

        self.repo
            .insert(
                notification_uuid,
                command.recipient_user_uuid,
                command.actor_user_uuid,
                &notification_type,
                &category,
                &text,
                command.post_uuid,
                command.comment_uuid,
                created_at,
            )
            .await?;

        let signal = RealtimeNotificationSignal {
            notification_uuid,
            notification_type,
            category,
            text,
            actor_user_uuid: command.actor_user_uuid,
            post_uuid: command.post_uuid,
            comment_uuid: command.comment_uuid,
            created_at,
        };

        self.realtime
            .publish_notification(command.recipient_user_uuid, &signal, false)
            .await;
        Ok(())
    }
}

impl UserNotificationDispatcher for InboxNotificationDispatcher {
    fn dispatch(
        &self,
        command: CreateUserNotificationCommand,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move { self.dispatch_inner(command).await })
    }
}
