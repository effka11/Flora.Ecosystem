//! SSE hub + FCM — паритет `UserRealtimePublisher.cs`.

use std::sync::Arc;

use flora_messaging_contracts::MessageSentContext;
use flora_notifications_contracts::{
    RealtimeMessageSignal, RealtimeNotificationRemovedSignal, RealtimeNotificationSignal,
};
use uuid::Uuid;

use crate::application::PushTokenService;
use crate::infrastructure::{
    ApnsPushSender, FcmPushSender, UserDisplayNameResolver, UserRealtimeHub,
};

/// FCM mode for social aggregation (audible budget / quiet replace / SSE-only).
#[derive(Debug, Clone)]
pub enum SocialNotificationPush {
    /// Within 15m cooldown: inbox+SSE only.
    SseOnly,
    /// Audible inbox push with `tag=group_key`.
    Audible { tag: String },
    /// Partial retract: same tray tag, current text; no audible budget update.
    QuietReplace { tag: String },
}

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

        if context.skip_push {
            return;
        }

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

        let sender = self
            .display_names
            .resolve_identity(signal.sender_user_uuid)
            .await;

        for record in records {
            let preview = context.encrypted_push_previews.iter().find(|preview| {
                Some(preview.installation_uuid) == record.installation_uuid
                    && Some(preview.preview_key_id) == record.preview_key_id
            });
            let capable = record.secure_preview_version == Some(1)
                && record.installation_uuid.is_some()
                && record.preview_key_id.is_some();
            let provider = record
                .provider
                .as_deref()
                .unwrap_or(record.platform.as_str());
            match (provider, record.platform.as_str()) {
                ("apns", "ios") if capable => {
                    self.apns_dispatcher
                        .send_message_push(
                            recipient_user_uuid,
                            &record.token,
                            &sender.display_name,
                            signal.conversation_uuid,
                            signal.sender_user_uuid,
                            context.persisted_message_uuid,
                            context.wire_message_uuid,
                            preview.map(|value| value.envelope.as_str()),
                        )
                        .await;
                }
                ("apns", "ios") => {
                    tracing::debug!(
                        recipient = %recipient_user_uuid,
                        "Skipping iOS push without secure preview capability"
                    );
                }
                _ => {
                    // Android/FCM: always data-only so FloraSecurePush owns the tray
                    // (system `notification` payloads hide MessagingStyle / largeIcon).
                    tracing::info!(
                        recipient = %recipient_user_uuid,
                        capable,
                        platform = %record.platform,
                        has_preview = preview.is_some(),
                        has_avatar = sender.avatar_uuid.is_some(),
                        "FCM secure_message_v1 route"
                    );
                    self.push_dispatcher
                        .send_secure_message_push(
                            recipient_user_uuid,
                            &record.token,
                            &sender.display_name,
                            sender.avatar_uuid,
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

        let _ = self
            .push_dispatcher
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
                None,
            )
            .await;
    }

    /// Social apply/retract: SSE `notification` + optional tagged FCM.
    /// Returns whether an **Audible** push was accepted by FCM for ≥1 token (telemetry).
    /// Audible budget is claimed in the dispatcher tx before this call — FCM outcome
    /// must not reopen the 15m window (anti double-spend / stuck-retry spam).
    pub async fn publish_social_notification(
        &self,
        recipient_user_uuid: Uuid,
        signal: &RealtimeNotificationSignal,
        push: SocialNotificationPush,
    ) -> bool {
        if recipient_user_uuid.is_nil() {
            return false;
        }

        self.hub.publish_notification(recipient_user_uuid, signal);

        let (tag, count_toward_budget) = match &push {
            SocialNotificationPush::SseOnly => return false,
            SocialNotificationPush::Audible { tag } => (tag.as_str(), true),
            SocialNotificationPush::QuietReplace { tag } => (tag.as_str(), false),
        };

        let tokens = match self.push_tokens.tokens_for_user(recipient_user_uuid).await {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    recipient = %recipient_user_uuid,
                    "Social notification publish: failed to load push tokens"
                );
                return false;
            }
        };
        if tokens.is_empty() {
            return false;
        }

        let actor_name = match signal.actor_user_uuid {
            Some(actor) if !actor.is_nil() => Some(self.display_names.resolve(actor).await),
            _ => None,
        };

        let delivered = self
            .push_dispatcher
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
                Some(tag),
            )
            .await;
        count_toward_budget && delivered
    }

    /// Empty social retract: SSE `notification_removed` + data-only dismiss FCM.
    pub async fn publish_notification_removed(
        &self,
        recipient_user_uuid: Uuid,
        signal: &RealtimeNotificationRemovedSignal,
    ) {
        if recipient_user_uuid.is_nil() {
            return;
        }

        self.hub
            .publish_notification_removed(recipient_user_uuid, signal);

        let Some(tag) = signal
            .group_key
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            return;
        };

        let tokens = match self.push_tokens.tokens_for_user(recipient_user_uuid).await {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    recipient = %recipient_user_uuid,
                    "notification_removed publish: failed to load push tokens"
                );
                return;
            }
        };
        if tokens.is_empty() {
            return;
        }

        self.push_dispatcher
            .send_notification_dismiss(recipient_user_uuid, &tokens, signal.notification_uuid, tag)
            .await;
    }
}
