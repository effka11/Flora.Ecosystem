//! SSE hub + FCM — паритет `UserRealtimePublisher.cs`.

use std::sync::Arc;

use flora_messaging_contracts::MessageSentContext;
use flora_notifications_contracts::{RealtimeMessageSignal, RealtimeNotificationSignal};
use uuid::Uuid;

use crate::application::PushTokenService;
use crate::infrastructure::{
    ApnsPushSender, FcmPushSender, UserDisplayNameResolver, UserRealtimeHub,
};

pub struct UserRealtimePublisher {
    hub: Arc<UserRealtimeHub>,
    push_tokens: Arc<PushTokenService>,
    push_dispatcher: Arc<FcmPushSender>,
    apns_dispatcher: Arc<ApnsPushSender>,
    display_names: Arc<UserDisplayNameResolver>,
}

impl UserRealtimePublisher {
    pub fn new(
        hub: Arc<UserRealtimeHub>,
        push_tokens: Arc<PushTokenService>,
        push_dispatcher: Arc<FcmPushSender>,
        apns_dispatcher: Arc<ApnsPushSender>,
        display_names: Arc<UserDisplayNameResolver>,
    ) -> Self {
        Self {
            hub,
            push_tokens,
            push_dispatcher,
            apns_dispatcher,
            display_names,
        }
    }

    /// Privacy-инвариант (e2e-security.md §Уведомления): тело push всегда
    /// generic — содержимое сообщения через FCM не проходит.
    pub async fn publish_message(
        &self,
        recipient_user_uuid: Uuid,
        signal: &RealtimeMessageSignal,
        context: &MessageSentContext,
    ) {
        if recipient_user_uuid.is_nil() {
            return;
        }

        self.hub.publish_message(recipient_user_uuid, signal);

        let records = match self.push_tokens.records_for_user(recipient_user_uuid).await {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    recipient = %recipient_user_uuid,
                    "Realtime message publish: failed to load push tokens"
                );
                return;
            }
        };
        if records.is_empty() {
            return;
        }

        let display_name = self.display_names.resolve(signal.sender_user_uuid).await;

        let mut legacy_tokens = Vec::new();
        for record in records {
            let preview = context.encrypted_push_previews.iter().find(|preview| {
                Some(preview.installation_uuid) == record.installation_uuid
                    && Some(preview.preview_key_id) == record.preview_key_id
            });
            let capable = record.secure_preview_version == Some(1)
                && record.installation_uuid.is_some()
                && record.preview_key_id.is_some();
            if !capable {
                legacy_tokens.push(record.token);
                continue;
            }
            match (
                record
                    .provider
                    .as_deref()
                    .unwrap_or(record.platform.as_str()),
                record.platform.as_str(),
            ) {
                ("apns", "ios") => {
                    self.apns_dispatcher
                        .send_message_push(
                            recipient_user_uuid,
                            &record.token,
                            &display_name,
                            signal.conversation_uuid,
                            signal.sender_user_uuid,
                            context.persisted_message_uuid,
                            context.wire_message_uuid,
                            preview.map(|value| value.envelope.as_str()),
                        )
                        .await;
                }
                _ => {
                    self.push_dispatcher
                        .send_secure_message_push(
                            recipient_user_uuid,
                            &record.token,
                            &display_name,
                            signal.conversation_uuid,
                            signal.sender_user_uuid,
                            context.persisted_message_uuid,
                            context.wire_message_uuid,
                            preview.map(|value| value.envelope.as_str()),
                        )
                        .await;
                }
            }
        }
        if !legacy_tokens.is_empty() {
            self.push_dispatcher
                .send_message_push(
                    recipient_user_uuid,
                    &legacy_tokens,
                    &display_name,
                    signal.conversation_uuid,
                    signal.sender_user_uuid,
                )
                .await;
        }
    }

    /// Паритет `PublishNotificationAsync` — SSE `event: notification` + inbox FCM.
    pub async fn publish_notification(
        &self,
        recipient_user_uuid: Uuid,
        signal: &RealtimeNotificationSignal,
        skip_push: bool,
    ) {
        if recipient_user_uuid.is_nil() {
            return;
        }

        self.hub.publish_notification(recipient_user_uuid, signal);
        if skip_push {
            return;
        }

        if signal.notification_type == "app_update" {
            // Sideload wake: Android tokens only + data-only HIGH (see FcmPushSender).
            let tokens = match self
                .push_tokens
                .tokens_for_user_platform(recipient_user_uuid, "android")
                .await
            {
                Ok(t) => t,
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        recipient = %recipient_user_uuid,
                        "app_update publish: failed to load Android push tokens"
                    );
                    return;
                }
            };
            if tokens.is_empty() {
                return;
            }
            self.push_dispatcher
                .send_app_update_push(
                    recipient_user_uuid,
                    &tokens,
                    signal.notification_uuid,
                    &signal.text,
                    signal.update.as_ref(),
                )
                .await;
            return;
        }

        let tokens = match self.push_tokens.tokens_for_user(recipient_user_uuid).await {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    recipient = %recipient_user_uuid,
                    "Realtime notification publish: failed to load push tokens"
                );
                return;
            }
        };
        if tokens.is_empty() {
            return;
        }

        let actor_name = match signal.actor_user_uuid {
            Some(actor) if !actor.is_nil() => Some(self.display_names.resolve(actor).await),
            _ => None,
        };

        self.push_dispatcher
            .send_inbox_notification_push(
                recipient_user_uuid,
                &tokens,
                signal.notification_uuid,
                &signal.notification_type,
                &signal.category,
                &signal.text,
                actor_name.as_deref(),
                signal.post_uuid,
                signal.comment_uuid,
            )
            .await;
    }
}
