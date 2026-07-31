//! Сервис списка диалогов / unread — паритет `ConversationService` (C#).

use std::sync::Arc;

use chrono::{DateTime, SecondsFormat, Utc};
use flora_auth_contracts::AccountDirectory;
use flora_messaging_contracts::{
    ConversationListItemDto, ConversationsPageDto, DeleteConversationOutcome, DeleteMessageOutcome,
    LegacyConversationListItemDto, LegacyMessageThreadItemDto, LegacySendMessageRequest,
    LegacySendMessageResultDto, MessageItemDto, MessageSentContext, MessageSentNotifier,
    MessageTypingNotifier, MessagesPageDto, PostConversationMessageRequest, PushPreviewTarget,
    PushPreviewTargetProvider, SendMessageResultDto,
};
use flora_shared::uuid_v5::dm_conversation_uuid;
use flora_users_contracts::{FeedAuthorProfiles, MessagesAccess, OnlineStatusAccess, UserPresence};
use uuid::Uuid;

use crate::application::cursor::{decode_cursor, encode_cursor};
use crate::infrastructure::MessagingRepo;

/// Ошибки POST message (маппятся в HTTP в `http/mod.rs`).
#[derive(Debug, Clone)]
pub enum SendMessageError {
    BadRequest(String),
    NotFound(String),
    Forbidden(String),
}

pub struct ConversationService {
    repo: Arc<MessagingRepo>,
    accounts: Arc<dyn AccountDirectory>,
    profiles: Arc<dyn FeedAuthorProfiles>,
    presence: Arc<dyn UserPresence>,
    online_access: Arc<dyn OnlineStatusAccess>,
    messages_access: Arc<dyn MessagesAccess>,
    sent_notifier: Arc<dyn MessageSentNotifier>,
    typing_notifier: Arc<dyn MessageTypingNotifier>,
    preview_targets: Arc<dyn PushPreviewTargetProvider>,
}

impl ConversationService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        repo: Arc<MessagingRepo>,
        accounts: Arc<dyn AccountDirectory>,
        profiles: Arc<dyn FeedAuthorProfiles>,
        presence: Arc<dyn UserPresence>,
        online_access: Arc<dyn OnlineStatusAccess>,
        messages_access: Arc<dyn MessagesAccess>,
        sent_notifier: Arc<dyn MessageSentNotifier>,
        typing_notifier: Arc<dyn MessageTypingNotifier>,
        preview_targets: Arc<dyn PushPreviewTargetProvider>,
    ) -> Self {
        Self {
            repo,
            accounts,
            profiles,
            presence,
            online_access,
            messages_access,
            sent_notifier,
            typing_notifier,
            preview_targets,
        }
    }

    pub async fn push_preview_targets(
        &self,
        sender_uuid: Uuid,
        recipient_uuid: Uuid,
    ) -> Result<Vec<PushPreviewTarget>, SendMessageError> {
        if sender_uuid == recipient_uuid {
            return Ok(Vec::new());
        }
        let can_send = self
            .messages_access
            .can_send_messages(sender_uuid, recipient_uuid)
            .await
            .map_err(SendMessageError::BadRequest)?;
        if !can_send {
            return Err(SendMessageError::Forbidden(
                "Пользователь ограничил входящие сообщения.".into(),
            ));
        }
        self.preview_targets
            .targets_for(recipient_uuid)
            .await
            .map_err(SendMessageError::BadRequest)
    }

    pub async fn total_unread_count(&self, user_uuid: Uuid) -> Result<i64, String> {
        self.repo.total_unread_count(user_uuid).await
    }

    pub async fn conversations_page(
        &self,
        user_uuid: Uuid,
        cursor: Option<&str>,
        take: i32,
    ) -> Result<ConversationsPageDto, String> {
        let take = take.clamp(1, 100) as usize;
        let cursor_at = decode_cursor(cursor);

        if let Err(e) = self.presence.touch(user_uuid).await {
            tracing::warn!(error = %e, "messaging presence touch failed");
        }

        let peers = self.repo.peer_rows(user_uuid).await?;
        let filtered: Vec<_> = match cursor_at {
            Some(at) => peers
                .into_iter()
                .filter(|p| p.last_message_at < at)
                .collect(),
            None => peers,
        };

        let has_more = filtered.len() > take;
        let page: Vec<_> = filtered.into_iter().take(take).collect();

        if page.is_empty() {
            return Ok(ConversationsPageDto {
                items: Vec::new(),
                next_cursor: None,
                has_more: false,
            });
        }

        let other_uuids: Vec<Uuid> = page.iter().map(|p| p.other_user_uuid).collect();
        let usernames = self.accounts.usernames_by_uuids(&other_uuids).await?;
        let profiles = self.profiles.by_uuids(&other_uuids).await?;
        let last_seen = self.presence.last_seen_by_uuids(&other_uuids).await?;
        let online_flags = self.presence.is_online_by_uuids(&other_uuids).await?;

        let user_by: std::collections::HashMap<_, _> = usernames.into_iter().collect();
        let prof_by: std::collections::HashMap<_, _> =
            profiles.into_iter().map(|p| (p.user_uuid, p)).collect();
        let seen_by: std::collections::HashMap<_, _> = last_seen.into_iter().collect();
        let online_by: std::collections::HashMap<_, _> = online_flags.into_iter().collect();

        let mut items = Vec::with_capacity(page.len());
        for peer in &page {
            let username = user_by
                .get(&peer.other_user_uuid)
                .cloned()
                .unwrap_or_default();
            let prof = prof_by.get(&peer.other_user_uuid);
            let display = prof
                .map(|p| p.display_name.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| username.clone());
            let avatar = prof.and_then(|p| p.avatar_uuid.map(|u| u.to_string()));

            let can_see = self
                .online_access
                .can_see_online(user_uuid, peer.other_user_uuid)
                .await?;
            let (other_user_is_online, other_user_last_seen_at) = resolve_online_for_viewer(
                can_see,
                *online_by.get(&peer.other_user_uuid).unwrap_or(&false),
                seen_by.get(&peer.other_user_uuid).copied(),
            );

            items.push(ConversationListItemDto {
                conversation_uuid: dm_conversation_uuid(&user_uuid, &peer.other_user_uuid),
                other_user_uuid: peer.other_user_uuid,
                other_username: username,
                other_display_name: display,
                other_avatar_uuid: avatar,
                last_message_encrypted_for_me: peer.last_encrypted_for_me.clone(),
                last_message_content: peer.last_content.clone(),
                last_message_at: format_utc(peer.last_message_at),
                last_message_is_from_me: peer.last_is_from_me,
                unread_count: peer.unread_count,
                other_user_is_online,
                other_user_last_seen_at,
            });
        }

        let next_cursor = if has_more {
            page.last().map(|p| encode_cursor(p.last_message_at))
        } else {
            None
        };

        Ok(ConversationsPageDto {
            items,
            next_cursor,
            has_more,
        })
    }

    pub async fn messages_page(
        &self,
        user_uuid: Uuid,
        conversation_uuid: Uuid,
        other_user_uuid: Option<Uuid>,
        cursor: Option<&str>,
        take: i32,
    ) -> Result<Option<MessagesPageDto>, String> {
        let take = take.clamp(1, 100) as usize;
        let cursor_at = decode_cursor(cursor);

        let peers = self.repo.peer_rows(user_uuid).await?;
        let other = resolve_other_user(
            user_uuid,
            peers.iter().map(|p| p.other_user_uuid),
            conversation_uuid,
            other_user_uuid,
        );
        let Some(other_uuid) = other else {
            return Ok(None);
        };

        let rows = self
            .repo
            .messages_page(user_uuid, other_uuid, cursor_at, take + 1)
            .await?;

        let has_more = rows.len() > take;
        let page: Vec<_> = rows.into_iter().take(take).collect();

        let items: Vec<MessageItemDto> = page
            .iter()
            .map(|m| MessageItemDto {
                message_uuid: m.message_uuid,
                sender_user_uuid: m.sender_user_uuid,
                encrypted_for_me: m.encrypted_for_me.clone(),
                content: m.content.clone(),
                created_at: format_utc(m.created_at),
                is_read: m.is_read,
                is_from_me: m.is_from_me,
                voice_asset_uuids: m.voice_asset_uuids.clone(),
                image_asset_uuids: m.image_asset_uuids.clone(),
                video_asset_uuids: m.video_asset_uuids.clone(),
            })
            .collect();

        let next_cursor = if has_more {
            page.last().map(|m| encode_cursor(m.created_at))
        } else {
            None
        };

        Ok(Some(MessagesPageDto {
            items,
            next_cursor,
            has_more,
        }))
    }

    pub async fn send_message(
        &self,
        sender_uuid: Uuid,
        conversation_uuid: Uuid,
        request: PostConversationMessageRequest,
    ) -> Result<SendMessageResultDto, SendMessageError> {
        if request.encrypted_for_receiver.trim().is_empty()
            || request.encrypted_for_sender.trim().is_empty()
        {
            return Err(SendMessageError::BadRequest(
                "Поля encryptedForReceiver и encryptedForSender обязательны.".into(),
            ));
        }

        let receiver_uuid =
            fscp_core::try_extract_receiver(&request.encrypted_for_receiver, sender_uuid)
                .map_err(SendMessageError::BadRequest)?;

        let expected_conv = dm_conversation_uuid(&sender_uuid, &receiver_uuid);
        if expected_conv != conversation_uuid {
            return Err(SendMessageError::BadRequest(
                "conversationUuid в пути не совпадает с участниками FSCP wire.".into(),
            ));
        }

        fscp_core::try_validate_dual_wire(
            &request.encrypted_for_receiver,
            &request.encrypted_for_sender,
            sender_uuid,
            receiver_uuid,
        )
        .map_err(SendMessageError::BadRequest)?;

        // Errata-5 (defense-in-depth): после замороженного валидатора формы —
        // криптопроверка Ed25519-подписи конверта. Содержимое по-прежнему
        // не расшифровывается (§4.4), отклоняется только порченый/подделанный конверт.
        fscp_core::verify_envelope_signature(&request.encrypted_for_receiver)
            .map_err(SendMessageError::BadRequest)?;
        let wire_message_uuid = fscp_core::extract_message_uuid(&request.encrypted_for_receiver)
            .map_err(SendMessageError::BadRequest)?;

        // Device revocation policy (FSCP.md §Device revocation, golden
        // fscp-revoked-device-v1.json): wire от отозванного senderDeviceUuid
        // отклоняется. Bootstrap sentinel v1 не имеет bindings — без запроса к БД.
        let sender_device = fscp_core::extract_sender_device_uuid(&request.encrypted_for_receiver)
            .map_err(SendMessageError::BadRequest)?;
        if sender_device != fscp_core::BOOTSTRAP_DEVICE_UUID
            && self
                .repo
                .is_sender_device_revoked(sender_uuid, sender_device)
                .await
                .map_err(SendMessageError::BadRequest)?
        {
            return Err(SendMessageError::Forbidden(
                fscp_core::REVOKED_SENDER_DEVICE_ERROR.into(),
            ));
        }

        let receiver_exists = self
            .accounts
            .get_public(receiver_uuid)
            .await
            .map_err(SendMessageError::BadRequest)?;
        if receiver_exists.is_none() {
            return Err(SendMessageError::NotFound("Получатель не найден.".into()));
        }

        let can_send = self
            .messages_access
            .can_send_messages(sender_uuid, receiver_uuid)
            .await
            .map_err(SendMessageError::BadRequest)?;
        if !can_send {
            return Err(SendMessageError::Forbidden(
                "Пользователь ограничил входящие сообщения.".into(),
            ));
        }

        // Push preview — advisory. Повреждённый/stale target не блокирует message;
        // Notifications повторно сверит installation+key с актуальным token.
        let mut encrypted_push_previews = Vec::new();
        let mut seen_preview_targets = std::collections::HashSet::new();
        for candidate in request.encrypted_push_previews.iter().take(8) {
            match fscp_core::try_validate_notification_preview(
                &candidate.envelope,
                &request.encrypted_for_receiver,
                receiver_uuid,
            ) {
                Ok(summary)
                    if summary.recipient_installation_uuid == candidate.installation_uuid
                        && summary.preview_key_id == candidate.preview_key_id
                        && summary.conversation_uuid == conversation_uuid
                        && summary.wire_message_uuid == wire_message_uuid
                        && summary.is_fresh_at(Utc::now())
                        && seen_preview_targets
                            .insert((candidate.installation_uuid, candidate.preview_key_id)) =>
                {
                    encrypted_push_previews.push(candidate.clone());
                }
                Ok(_) | Err(_) => {
                    tracing::warn!(
                        sender = %sender_uuid,
                        recipient = %receiver_uuid,
                        installation = %candidate.installation_uuid,
                        "dropped invalid encrypted push preview"
                    );
                }
            }
        }

        let voice_uuids = dedupe_uuids(request.voice_asset_uuids);
        let image_uuids = dedupe_uuids(request.image_asset_uuids);
        let video_uuids = dedupe_uuids(request.video_asset_uuids);

        let result = self
            .repo
            .send_message(
                sender_uuid,
                receiver_uuid,
                &request.encrypted_for_receiver,
                &request.encrypted_for_sender,
                &voice_uuids,
                &image_uuids,
                &video_uuids,
            )
            .await
            .map_err(SendMessageError::BadRequest)?;

        if let Err(e) = self.presence.touch(sender_uuid).await {
            tracing::warn!(error = %e, "messaging presence touch failed");
        }

        self.sent_notifier
            .notify(MessageSentContext {
                recipient_user_uuid: receiver_uuid,
                sender_user_uuid: sender_uuid,
                persisted_message_uuid: result.message_uuid,
                wire_message_uuid,
                encrypted_push_previews,
            })
            .await;

        Ok(SendMessageResultDto {
            message_uuid: result.message_uuid,
            created_at: format_utc(result.created_at),
            encrypted_for_me: result.encrypted_for_sender,
        })
    }

    pub async fn mark_read(
        &self,
        user_uuid: Uuid,
        conversation_uuid: Uuid,
        other_user_uuid: Option<Uuid>,
    ) -> Result<bool, String> {
        let peers = self.repo.peer_rows(user_uuid).await?;
        let other = resolve_other_user(
            user_uuid,
            peers.iter().map(|p| p.other_user_uuid),
            conversation_uuid,
            other_user_uuid,
        );
        let Some(other_uuid) = other else {
            return Ok(false);
        };
        if let Err(e) = self.presence.touch(user_uuid).await {
            tracing::warn!(error = %e, "messaging presence touch failed");
        }
        self.repo.mark_read(user_uuid, other_uuid).await?;
        Ok(true)
    }

    pub async fn set_typing(
        &self,
        user_uuid: Uuid,
        conversation_uuid: Uuid,
        other_user_uuid: Option<Uuid>,
        is_typing: bool,
    ) -> Result<bool, String> {
        let peers = self.repo.peer_rows(user_uuid).await?;
        let other = resolve_other_user(
            user_uuid,
            peers.iter().map(|p| p.other_user_uuid),
            conversation_uuid,
            other_user_uuid,
        );
        let Some(other_uuid) = other else {
            return Ok(false);
        };
        if let Err(e) = self.presence.touch(user_uuid).await {
            tracing::warn!(error = %e, "messaging presence touch failed");
        }
        self.typing_notifier
            .notify_typing(other_uuid, conversation_uuid, user_uuid, is_typing)
            .await;
        Ok(true)
    }

    pub async fn delete_message(
        &self,
        user_uuid: Uuid,
        conversation_uuid: Uuid,
        message_uuid: Uuid,
    ) -> Result<DeleteMessageOutcome, String> {
        self.repo
            .delete_message(user_uuid, conversation_uuid, message_uuid)
            .await
    }

    pub async fn delete_conversation(
        &self,
        user_uuid: Uuid,
        conversation_uuid: Uuid,
        other_user_uuid: Option<Uuid>,
    ) -> Result<DeleteConversationOutcome, String> {
        let peers = self.repo.peer_rows(user_uuid).await?;
        let other = resolve_other_user(
            user_uuid,
            peers.iter().map(|p| p.other_user_uuid),
            conversation_uuid,
            other_user_uuid,
        );
        let Some(other_uuid) = other else {
            return Ok(DeleteConversationOutcome::NotFound);
        };
        self.repo.delete_conversation(user_uuid, other_uuid).await
    }

    /// `GET /api/auth/conversations` — полный список (без cursor), C# shape.
    pub async fn legacy_conversations(
        &self,
        user_uuid: Uuid,
    ) -> Result<Vec<LegacyConversationListItemDto>, String> {
        if let Err(e) = self.presence.touch(user_uuid).await {
            tracing::warn!(error = %e, "messaging presence touch failed");
        }

        let peers = self.repo.peer_rows(user_uuid).await?;
        if peers.is_empty() {
            return Ok(Vec::new());
        }

        let other_uuids: Vec<Uuid> = peers.iter().map(|p| p.other_user_uuid).collect();
        let usernames = self.accounts.usernames_by_uuids(&other_uuids).await?;
        let profiles = self.profiles.by_uuids(&other_uuids).await?;
        let last_seen = self.presence.last_seen_by_uuids(&other_uuids).await?;
        let online_flags = self.presence.is_online_by_uuids(&other_uuids).await?;

        let user_by: std::collections::HashMap<_, _> = usernames.into_iter().collect();
        let prof_by: std::collections::HashMap<_, _> =
            profiles.into_iter().map(|p| (p.user_uuid, p)).collect();
        let seen_by: std::collections::HashMap<_, _> = last_seen.into_iter().collect();
        let online_by: std::collections::HashMap<_, _> = online_flags.into_iter().collect();

        let mut items = Vec::with_capacity(peers.len());
        for peer in &peers {
            let username = user_by
                .get(&peer.other_user_uuid)
                .cloned()
                .unwrap_or_default();
            let prof = prof_by.get(&peer.other_user_uuid);
            let display = prof
                .map(|p| p.display_name.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| username.clone());
            let avatar = prof.and_then(|p| p.avatar_uuid.map(|u| u.to_string()));

            let can_see = self
                .online_access
                .can_see_online(user_uuid, peer.other_user_uuid)
                .await?;
            let (other_user_is_online, other_user_last_seen_at) = resolve_online_for_viewer(
                can_see,
                *online_by.get(&peer.other_user_uuid).unwrap_or(&false),
                seen_by.get(&peer.other_user_uuid).copied(),
            );

            items.push(LegacyConversationListItemDto {
                other_user_uuid: peer.other_user_uuid,
                other_username: username,
                other_display_name: display,
                other_avatar_uuid: avatar,
                other_user_e2e_public_key_base64: None,
                last_message_uuid: peer.last_message_uuid,
                last_message_content: truncate_preview(peer.last_content.as_deref()),
                last_message_encrypted_for_me: peer.last_encrypted_for_me.clone(),
                last_message_is_from_me: peer.last_is_from_me,
                last_message_at: format_utc(peer.last_message_at),
                unread_count: peer.unread_count,
                other_user_is_online,
                other_user_last_seen_at,
            });
        }

        Ok(items)
    }

    /// `GET /api/auth/conversations/with/{other}` — skip/take, C# shape.
    pub async fn legacy_messages_with(
        &self,
        user_uuid: Uuid,
        other_user_uuid: Uuid,
        skip: i32,
        take: i32,
    ) -> Result<Result<Vec<LegacyMessageThreadItemDto>, SendMessageError>, String> {
        if other_user_uuid == user_uuid {
            return Ok(Err(SendMessageError::BadRequest(
                "Нельзя запросить переписку с самим собой.".into(),
            )));
        }
        let skip = skip.max(0) as usize;
        let take = take.clamp(1, 100) as usize;
        let rows = self
            .repo
            .messages_offset_page(user_uuid, other_user_uuid, skip, take)
            .await?;
        let items = rows
            .into_iter()
            .map(|m| {
                let receiver_user_uuid = if m.is_from_me {
                    other_user_uuid
                } else {
                    user_uuid
                };
                LegacyMessageThreadItemDto {
                    message_uuid: m.message_uuid,
                    sender_user_uuid: m.sender_user_uuid,
                    receiver_user_uuid,
                    content: m.content,
                    encrypted_for_me: m.encrypted_for_me,
                    created_at: format_utc(m.created_at),
                    is_read: m.is_read,
                    is_from_me: m.is_from_me,
                }
            })
            .collect();
        Ok(Ok(items))
    }

    /// `POST /api/auth/messages` — peer-based send, C# error texts + response shape.
    pub async fn legacy_send_message(
        &self,
        sender_uuid: Uuid,
        request: LegacySendMessageRequest,
    ) -> Result<LegacySendMessageResultDto, SendMessageError> {
        let to_uuid = request.to_user_uuid;
        if to_uuid == sender_uuid {
            return Err(SendMessageError::BadRequest(
                "Нельзя отправить сообщение себе.".into(),
            ));
        }

        let use_e2e = !request
            .encrypted_for_receiver
            .as_deref()
            .unwrap_or("")
            .is_empty()
            && !request
                .encrypted_for_sender
                .as_deref()
                .unwrap_or("")
                .is_empty();
        if !use_e2e {
            return Err(SendMessageError::BadRequest(
                "Сообщения принимаются только с end-to-end шифрованием (поля encryptedForReceiver и encryptedForSender). Обновите клиент."
                    .into(),
            ));
        }

        let encrypted_for_receiver = request
            .encrypted_for_receiver
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string();
        let encrypted_for_sender = request
            .encrypted_for_sender
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string();
        if encrypted_for_receiver.is_empty() || encrypted_for_sender.is_empty() {
            return Err(SendMessageError::BadRequest(
                "Для E2E нужны оба поля: encryptedForReceiver и encryptedForSender.".into(),
            ));
        }

        let conversation_uuid = dm_conversation_uuid(&sender_uuid, &to_uuid);
        let modern = PostConversationMessageRequest {
            encrypted_for_receiver,
            encrypted_for_sender,
            voice_asset_uuids: request.voice_asset_uuids,
            image_asset_uuids: request.image_asset_uuids,
            video_asset_uuids: Vec::new(),
            encrypted_push_previews: Vec::new(),
            push_preview: None,
        };

        match self
            .send_message(sender_uuid, conversation_uuid, modern)
            .await
        {
            Ok(r) => Ok(LegacySendMessageResultDto {
                message_uuid: r.message_uuid,
                content: None,
                encrypted_for_me: r.encrypted_for_me,
                created_at: r.created_at,
            }),
            Err(SendMessageError::NotFound(_)) => {
                Err(SendMessageError::NotFound("Пользователь не найден.".into()))
            }
            Err(e) => Err(e),
        }
    }

    /// `PATCH /api/auth/conversations/with/{other}/read` — всегда NoContent (как C#).
    pub async fn legacy_mark_read(
        &self,
        user_uuid: Uuid,
        other_user_uuid: Uuid,
    ) -> Result<(), String> {
        if let Err(e) = self.presence.touch(user_uuid).await {
            tracing::warn!(error = %e, "messaging presence touch failed");
        }
        self.repo.mark_read(user_uuid, other_user_uuid).await
    }

    /// `DELETE /api/auth/conversations/with/{other}`.
    pub async fn legacy_delete_conversation(
        &self,
        user_uuid: Uuid,
        other_user_uuid: Uuid,
    ) -> Result<Result<(), SendMessageError>, String> {
        if other_user_uuid == user_uuid {
            return Ok(Err(SendMessageError::BadRequest(
                "Нельзя удалить диалог с самим собой.".into(),
            )));
        }
        self.repo
            .delete_conversation(user_uuid, other_user_uuid)
            .await?;
        Ok(Ok(()))
    }

    /// `DELETE /api/auth/messages/{messageUuid}` — без conversationUuid в пути.
    pub async fn legacy_delete_message(
        &self,
        user_uuid: Uuid,
        message_uuid: Uuid,
    ) -> Result<DeleteMessageOutcome, String> {
        self.repo
            .delete_message_by_uuid(user_uuid, message_uuid)
            .await
    }
}

fn truncate_preview(content: Option<&str>) -> Option<String> {
    let content = content?;
    let mut chars = content.chars();
    let prefix: String = chars.by_ref().take(80).collect();
    if chars.next().is_some() {
        Some(format!("{prefix}…"))
    } else {
        Some(prefix)
    }
}

fn dedupe_uuids(uuids: Vec<Uuid>) -> Vec<Uuid> {
    let mut out = Vec::new();
    for u in uuids {
        if u.is_nil() {
            continue;
        }
        if !out.contains(&u) {
            out.push(u);
        }
    }
    out
}

fn resolve_other_user(
    user_uuid: Uuid,
    known_partners: impl IntoIterator<Item = Uuid>,
    conversation_uuid: Uuid,
    other_user_uuid: Option<Uuid>,
) -> Option<Uuid> {
    for partner in known_partners {
        if dm_conversation_uuid(&user_uuid, &partner) == conversation_uuid {
            return Some(partner);
        }
    }
    let other = other_user_uuid.filter(|u| !u.is_nil() && *u != user_uuid)?;
    if dm_conversation_uuid(&user_uuid, &other) == conversation_uuid {
        Some(other)
    } else {
        None
    }
}

fn format_utc(dt: DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Resolve online for viewer using Users hot-path flag + last_seen for text.
fn resolve_online_for_viewer(
    can_see: bool,
    is_online: bool,
    last_seen: Option<DateTime<Utc>>,
) -> (bool, Option<String>) {
    if !can_see {
        return (false, None);
    }
    let last_seen_at = last_seen.map(format_utc);
    (is_online, last_seen_at)
}
