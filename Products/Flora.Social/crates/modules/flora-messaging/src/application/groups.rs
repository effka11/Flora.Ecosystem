//! FSCP-G group conversations — create/roster/send/list (Messaging owns roster + wire storage).

use std::collections::HashSet;
use std::sync::Arc;

use chrono::{DateTime, SecondsFormat, Utc};
use flora_auth_contracts::AccountDirectory;
use flora_messaging_contracts::{
    AddGroupMemberRequest, CreateGroupRequest, GroupDetailDto, GroupListItemDto, GroupMemberDto,
    GroupMessageItemDto, GroupMessagesPageDto, GroupsPageDto, MessageConversationKind,
    MessageSentContext, MessageSentNotifier, PatchGroupRequest, PostGroupMessageRequest,
    SendGroupMessageResultDto,
};
use flora_users_contracts::{FeedAuthorProfiles, MessagesAccess};
use fscp_core::{
    BOOTSTRAP_KEY_EPOCH_ID, GROUP_MAX_MEMBERS, REVOKED_SENDER_DEVICE_ERROR, try_validate_group_wire,
    verify_group_envelope_signature,
};
use uuid::Uuid;

use crate::application::cursor::{decode_cursor, encode_cursor};
use crate::application::e2e::E2eKeyBackupService;
use crate::application::SendMessageError;
use crate::infrastructure::{GroupRepo, InsertMessageOutcome, MessagingRepo};

pub struct GroupService {
    groups: Arc<GroupRepo>,
    messaging: Arc<MessagingRepo>,
    accounts: Arc<dyn AccountDirectory>,
    profiles: Arc<dyn FeedAuthorProfiles>,
    messages_access: Arc<dyn MessagesAccess>,
    e2e: Arc<E2eKeyBackupService>,
    sent_notifier: Arc<dyn MessageSentNotifier>,
}

impl GroupService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        groups: Arc<GroupRepo>,
        messaging: Arc<MessagingRepo>,
        accounts: Arc<dyn AccountDirectory>,
        profiles: Arc<dyn FeedAuthorProfiles>,
        messages_access: Arc<dyn MessagesAccess>,
        e2e: Arc<E2eKeyBackupService>,
        sent_notifier: Arc<dyn MessageSentNotifier>,
    ) -> Self {
        Self {
            groups,
            messaging,
            accounts,
            profiles,
            messages_access,
            e2e,
            sent_notifier,
        }
    }

    pub async fn create_group(
        &self,
        creator: Uuid,
        request: CreateGroupRequest,
    ) -> Result<GroupDetailDto, SendMessageError> {
        let title = normalize_title_for_create(request.title.as_deref())?;
        let mut members: HashSet<Uuid> = HashSet::new();
        members.insert(creator);
        for raw in request.member_user_uuids {
            if raw.is_nil() || raw == creator {
                continue;
            }
            members.insert(raw);
        }
        if members.len() < 2 {
            return Err(SendMessageError::BadRequest(
                "Группа должна включать хотя бы одного другого участника.".into(),
            ));
        }
        if members.len() > GROUP_MAX_MEMBERS {
            return Err(SendMessageError::BadRequest(format!(
                "Не больше {GROUP_MAX_MEMBERS} участников в группе."
            )));
        }

        for &uid in &members {
            if uid == creator {
                continue;
            }
            let exists = self
                .accounts
                .get_public(uid)
                .await
                .map_err(SendMessageError::BadRequest)?;
            if exists.is_none() {
                return Err(SendMessageError::NotFound("Участник не найден.".into()));
            }
            let can_send = self
                .messages_access
                .can_send_messages(creator, uid)
                .await
                .map_err(SendMessageError::BadRequest)?;
            if !can_send {
                return Err(SendMessageError::Forbidden(
                    "Нельзя добавить участника: ограничены входящие сообщения.".into(),
                ));
            }
            self.require_e2e_key(uid).await?;
        }
        self.require_e2e_key(creator).await?;

        let conversation_uuid = Uuid::now_v7();
        let now = Utc::now();
        let mut tx = self.groups.begin().await.map_err(SendMessageError::BadRequest)?;
        GroupRepo::insert_conversation(
            &mut tx,
            conversation_uuid,
            &title,
            creator,
            BOOTSTRAP_KEY_EPOCH_ID,
            now,
        )
        .await
        .map_err(SendMessageError::BadRequest)?;
        for uid in &members {
            GroupRepo::upsert_member_active(&mut tx, conversation_uuid, *uid, now)
                .await
                .map_err(SendMessageError::BadRequest)?;
        }
        tx.commit()
            .await
            .map_err(|e| SendMessageError::BadRequest(e.to_string()))?;

        self.group_detail(creator, conversation_uuid)
            .await?
            .ok_or_else(|| SendMessageError::NotFound("Разговор не найден.".into()))
    }

    pub async fn list_groups(&self, user_uuid: Uuid) -> Result<GroupsPageDto, String> {
        let rows = self.groups.list_groups_for_user(user_uuid).await?;
        let items = rows
            .into_iter()
            .map(|r| GroupListItemDto {
                conversation_uuid: r.conversation_uuid,
                title: r.title,
                created_by_user_uuid: r.created_by_user_uuid,
                created_at: format_utc(r.created_at),
                member_count: r.member_count,
                last_message_encrypted_wire: r.last_message_encrypted_wire,
                last_message_at: r.last_message_at.map(format_utc),
                last_message_is_from_me: r.last_message_sender == Some(user_uuid),
                unread_count: r.unread_count,
            })
            .collect();
        Ok(GroupsPageDto { items })
    }

    pub async fn group_detail(
        &self,
        viewer: Uuid,
        conversation_uuid: Uuid,
    ) -> Result<Option<GroupDetailDto>, SendMessageError> {
        let membership = self
            .groups
            .active_membership(conversation_uuid, viewer)
            .await
            .map_err(SendMessageError::BadRequest)?;
        if membership.is_none() {
            return Ok(None);
        }
        let conv = self
            .groups
            .get_conversation(conversation_uuid)
            .await
            .map_err(SendMessageError::BadRequest)?;
        let Some(conv) = conv else {
            return Ok(None);
        };
        let members = self
            .groups
            .list_active_members(conversation_uuid)
            .await
            .map_err(SendMessageError::BadRequest)?;
        let uuids: Vec<Uuid> = members.iter().map(|m| m.user_uuid).collect();
        let usernames = self
            .accounts
            .usernames_by_uuids(&uuids)
            .await
            .map_err(SendMessageError::BadRequest)?;
        let profiles = self
            .profiles
            .by_uuids(&uuids)
            .await
            .map_err(SendMessageError::BadRequest)?;
        let user_by: std::collections::HashMap<_, _> = usernames.into_iter().collect();
        let prof_by: std::collections::HashMap<_, _> =
            profiles.into_iter().map(|p| (p.user_uuid, p)).collect();

        let member_dtos = members
            .into_iter()
            .map(|m| {
                let username = user_by.get(&m.user_uuid).cloned().unwrap_or_default();
                let prof = prof_by.get(&m.user_uuid);
                let display = prof
                    .map(|p| p.display_name.clone())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| username.clone());
                GroupMemberDto {
                    user_uuid: m.user_uuid,
                    username,
                    display_name: display,
                    avatar_uuid: prof.and_then(|p| p.avatar_uuid.map(|u| u.to_string())),
                    joined_at: format_utc(m.joined_at),
                }
            })
            .collect();

        Ok(Some(GroupDetailDto {
            conversation_uuid: conv.conversation_uuid,
            title: conv.title,
            created_by_user_uuid: conv.created_by_user_uuid,
            created_at: format_utc(conv.created_at),
            members: member_dtos,
        }))
    }

    pub async fn patch_title(
        &self,
        actor: Uuid,
        conversation_uuid: Uuid,
        request: PatchGroupRequest,
    ) -> Result<Option<GroupDetailDto>, SendMessageError> {
        let title = normalize_title_for_patch(&request.title)?;
        let conv = self
            .groups
            .get_conversation(conversation_uuid)
            .await
            .map_err(SendMessageError::BadRequest)?;
        let Some(conv) = conv else {
            return Ok(None);
        };
        let membership = self
            .groups
            .active_membership(conversation_uuid, actor)
            .await
            .map_err(SendMessageError::BadRequest)?;
        if membership.is_none() {
            return Ok(None);
        }
        require_group_creator(actor, conv.created_by_user_uuid, "изменить название группы")?;
        self.groups
            .update_title(conversation_uuid, &title)
            .await
            .map_err(SendMessageError::BadRequest)?;
        self.group_detail(actor, conversation_uuid).await
    }

    pub async fn add_member(
        &self,
        actor: Uuid,
        conversation_uuid: Uuid,
        request: AddGroupMemberRequest,
    ) -> Result<Option<GroupDetailDto>, SendMessageError> {
        let new_user = request.user_uuid;
        if new_user.is_nil() {
            return Err(SendMessageError::BadRequest("Неверный userUuid.".into()));
        }
        let conv = self
            .groups
            .get_conversation(conversation_uuid)
            .await
            .map_err(SendMessageError::BadRequest)?;
        let Some(conv) = conv else {
            return Ok(None);
        };
        let actor_membership = self
            .groups
            .active_membership(conversation_uuid, actor)
            .await
            .map_err(SendMessageError::BadRequest)?;
        if actor_membership.is_none() {
            return Ok(None);
        }
        require_group_creator(actor, conv.created_by_user_uuid, "добавлять участников")?;

        let active = self
            .groups
            .active_member_uuids(conversation_uuid)
            .await
            .map_err(SendMessageError::BadRequest)?;
        if active.contains(&new_user) {
            return self.group_detail(actor, conversation_uuid).await;
        }
        if active.len() + 1 > GROUP_MAX_MEMBERS {
            return Err(SendMessageError::BadRequest(format!(
                "Не больше {GROUP_MAX_MEMBERS} участников в группе."
            )));
        }

        let exists = self
            .accounts
            .get_public(new_user)
            .await
            .map_err(SendMessageError::BadRequest)?;
        if exists.is_none() {
            return Err(SendMessageError::NotFound("Участник не найден.".into()));
        }
        let can_send = self
            .messages_access
            .can_send_messages(actor, new_user)
            .await
            .map_err(SendMessageError::BadRequest)?;
        if !can_send {
            return Err(SendMessageError::Forbidden(
                "Нельзя добавить участника: ограничены входящие сообщения.".into(),
            ));
        }
        self.require_e2e_key(new_user).await?;

        let now = Utc::now();
        let mut tx = self.groups.begin().await.map_err(SendMessageError::BadRequest)?;
        GroupRepo::upsert_member_active(&mut tx, conversation_uuid, new_user, now)
            .await
            .map_err(SendMessageError::BadRequest)?;
        tx.commit()
            .await
            .map_err(|e| SendMessageError::BadRequest(e.to_string()))?;

        self.group_detail(actor, conversation_uuid).await
    }

    pub async fn remove_member(
        &self,
        actor: Uuid,
        conversation_uuid: Uuid,
        target: Uuid,
    ) -> Result<Option<()>, SendMessageError> {
        if target == actor {
            return Err(SendMessageError::BadRequest(
                "Для выхода из группы используйте leave.".into(),
            ));
        }
        let conv = self
            .groups
            .get_conversation(conversation_uuid)
            .await
            .map_err(SendMessageError::BadRequest)?;
        let Some(conv) = conv else {
            return Ok(None);
        };
        let actor_membership = self
            .groups
            .active_membership(conversation_uuid, actor)
            .await
            .map_err(SendMessageError::BadRequest)?;
        if actor_membership.is_none() {
            return Ok(None);
        }
        require_group_creator(actor, conv.created_by_user_uuid, "удалять участников")?;
        let removed = self
            .groups
            .set_member_left(conversation_uuid, target, Utc::now())
            .await
            .map_err(SendMessageError::BadRequest)?;
        if !removed {
            return Ok(None);
        }
        Ok(Some(()))
    }

    pub async fn leave(
        &self,
        user_uuid: Uuid,
        conversation_uuid: Uuid,
    ) -> Result<Option<()>, SendMessageError> {
        let membership = self
            .groups
            .active_membership(conversation_uuid, user_uuid)
            .await
            .map_err(SendMessageError::BadRequest)?;
        if membership.is_none() {
            return Ok(None);
        }
        let left = self
            .groups
            .set_member_left(conversation_uuid, user_uuid, Utc::now())
            .await
            .map_err(SendMessageError::BadRequest)?;
        if !left {
            return Ok(None);
        }
        Ok(Some(()))
    }

    pub async fn messages_page(
        &self,
        viewer: Uuid,
        conversation_uuid: Uuid,
        cursor: Option<&str>,
        take: i32,
    ) -> Result<Option<GroupMessagesPageDto>, SendMessageError> {
        let membership = self
            .groups
            .active_membership(conversation_uuid, viewer)
            .await
            .map_err(SendMessageError::BadRequest)?;
        let Some(membership) = membership else {
            return Ok(None);
        };
        let take = take.clamp(1, 100);
        let cursor_at = decode_cursor(cursor);
        let mut rows = self
            .groups
            .messages_page(conversation_uuid, membership.joined_at, cursor_at, take + 1)
            .await
            .map_err(SendMessageError::BadRequest)?;
        let has_more = rows.len() > take as usize;
        if has_more {
            rows.truncate(take as usize);
        }
        let next_cursor = if has_more {
            rows.last().map(|r| encode_cursor(r.created_at))
        } else {
            None
        };
        let items = rows
            .into_iter()
            .map(|r| GroupMessageItemDto {
                message_uuid: r.message_uuid,
                sender_user_uuid: r.sender_user_uuid,
                encrypted_wire: r.encrypted_wire,
                created_at: format_utc(r.created_at),
                is_from_me: r.sender_user_uuid == viewer,
            })
            .collect();
        Ok(Some(GroupMessagesPageDto {
            items,
            next_cursor,
            has_more,
        }))
    }

    pub async fn send_message(
        &self,
        sender: Uuid,
        conversation_uuid: Uuid,
        request: PostGroupMessageRequest,
    ) -> Result<SendGroupMessageResultDto, GroupSendError> {
        let wire = request.encrypted_wire.trim();
        if wire.is_empty() {
            return Err(GroupSendError::BadRequest(
                "Поле encryptedWire обязательно.".into(),
            ));
        }
        reject_group_video_assets(&request.video_asset_uuids)?;
        let voice_uuids = dedupe_uuids(&request.voice_asset_uuids);
        let image_uuids = dedupe_uuids(&request.image_asset_uuids);

        let mut tx = self
            .groups
            .begin()
            .await
            .map_err(GroupSendError::BadRequest)?;
        let active = GroupRepo::lock_active_member_uuids(&mut tx, conversation_uuid)
            .await
            .map_err(GroupSendError::BadRequest)?;
        if !active.contains(&sender) {
            return Err(GroupSendError::NotFound);
        }

        let summary = try_validate_group_wire(wire, sender, conversation_uuid, &active)
            .map_err(GroupSendError::BadRequest)?;
        verify_group_envelope_signature(wire).map_err(GroupSendError::BadRequest)?;

        if summary.sender_device_uuid != fscp_core::BOOTSTRAP_DEVICE_UUID
            && self
                .messaging
                .is_sender_device_revoked(sender, summary.sender_device_uuid)
                .await
                .map_err(GroupSendError::BadRequest)?
        {
            return Err(GroupSendError::Forbidden(
                REVOKED_SENDER_DEVICE_ERROR.into(),
            ));
        }

        let now = Utc::now();
        let outcome = GroupRepo::insert_message(
            &mut tx,
            summary.message_uuid,
            conversation_uuid,
            sender,
            wire,
            now,
        )
        .await
        .map_err(GroupSendError::BadRequest)?;

        let (created_at, encrypted_wire, notify) = match outcome {
            InsertMessageOutcome::Inserted { created_at } => {
                GroupRepo::bind_voice_assets(
                    &mut tx,
                    summary.message_uuid,
                    conversation_uuid,
                    sender,
                    &voice_uuids,
                )
                .await
                .map_err(GroupSendError::BadRequest)?;
                GroupRepo::bind_image_assets(
                    &mut tx,
                    summary.message_uuid,
                    conversation_uuid,
                    sender,
                    &image_uuids,
                )
                .await
                .map_err(GroupSendError::BadRequest)?;
                (created_at, wire.to_string(), true)
            }
            InsertMessageOutcome::Idempotent {
                created_at,
                encrypted_wire,
            } => {
                // Retry after success: assets must already be bound to this message.
                if !voice_uuids.is_empty() || !image_uuids.is_empty() {
                    let ok = GroupRepo::assets_already_bound_to_message(
                        &mut tx,
                        summary.message_uuid,
                        conversation_uuid,
                        &voice_uuids,
                        &image_uuids,
                    )
                    .await
                    .map_err(GroupSendError::BadRequest)?;
                    if !ok {
                        return Err(GroupSendError::BadRequest(
                            "Вложения не соответствуют идемпотентному групповому сообщению."
                                .into(),
                        ));
                    }
                }
                (created_at, encrypted_wire, false)
            }
            InsertMessageOutcome::Conflict => {
                return Err(GroupSendError::Conflict);
            }
        };

        let notify_roster = active.clone();
        tx.commit()
            .await
            .map_err(|e| GroupSendError::BadRequest(e.to_string()))?;

        if notify {
            for recipient in notify_roster {
                if recipient == sender {
                    continue;
                }
                self.sent_notifier
                    .notify(MessageSentContext {
                        conversation_uuid,
                        recipient_user_uuid: recipient,
                        sender_user_uuid: sender,
                        persisted_message_uuid: summary.message_uuid,
                        wire_message_uuid: summary.message_uuid,
                        encrypted_push_previews: Vec::new(),
                        skip_push: true,
                        kind: MessageConversationKind::GroupChat,
                    })
                    .await;
            }
        }

        Ok(SendGroupMessageResultDto {
            message_uuid: summary.message_uuid,
            created_at: format_utc(created_at),
            encrypted_wire,
        })
    }

    pub async fn mark_read(
        &self,
        user_uuid: Uuid,
        conversation_uuid: Uuid,
    ) -> Result<Option<()>, SendMessageError> {
        let membership = self
            .groups
            .active_membership(conversation_uuid, user_uuid)
            .await
            .map_err(SendMessageError::BadRequest)?;
        if membership.is_none() {
            return Ok(None);
        }
        self.groups
            .upsert_read(conversation_uuid, user_uuid, Utc::now())
            .await
            .map_err(SendMessageError::BadRequest)?;
        Ok(Some(()))
    }

    pub async fn group_unread_count(&self, user_uuid: Uuid) -> Result<i64, String> {
        self.groups.group_unread_conversation_count(user_uuid).await
    }

    /// Mirror ORG `archivedByConversation` into SQL for unread badge / icon LIMIT.
    pub async fn set_group_archived(
        &self,
        owner: Uuid,
        conversation_uuid: Uuid,
        archived: bool,
    ) -> Result<(), SendMessageError> {
        const MAX_FOLDER_ICONS: i64 = 4;
        self.groups
            .set_group_archived_checked(
                owner,
                conversation_uuid,
                archived,
                Utc::now(),
                MAX_FOLDER_ICONS,
            )
            .await
            .map_err(|e| {
                if let Some(msg) = e.strip_prefix("LIMIT:") {
                    SendMessageError::BadRequest(msg.to_string())
                } else if let Some(msg) = e.strip_prefix("NOT_FOUND:") {
                    SendMessageError::NotFound(msg.to_string())
                } else {
                    SendMessageError::BadRequest(e)
                }
            })
    }

    pub async fn list_archived_group_uuids(&self, owner: Uuid) -> Result<Vec<Uuid>, String> {
        self.groups
            .list_archived_group_conversation_uuids(owner)
            .await
    }

    async fn require_e2e_key(&self, user_uuid: Uuid) -> Result<(), SendMessageError> {
        match self.e2e.get_user_public_key(user_uuid).await {
            Ok(_) => Ok(()),
            Err(crate::application::GetE2ePublicKeyError::NotFound) => {
                Err(SendMessageError::BadRequest(
                    "У участника нет опубликованного E2E-ключа.".into(),
                ))
            }
            Err(crate::application::GetE2ePublicKeyError::Internal { detail }) => {
                Err(SendMessageError::BadRequest(detail))
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupSendError {
    BadRequest(String),
    Forbidden(String),
    NotFound,
    Conflict,
}

fn format_utc(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn normalize_title_for_create(raw: Option<&str>) -> Result<String, SendMessageError> {
    let trimmed = raw.map(str::trim).unwrap_or("").to_string();
    if trimmed.is_empty() {
        return Ok("Группа".into());
    }
    if trimmed.chars().count() > 40 {
        return Err(SendMessageError::BadRequest(
            "Название группы не длиннее 40 символов.".into(),
        ));
    }
    if trimmed.contains('\n') || trimmed.contains('\r') {
        return Err(SendMessageError::BadRequest(
            "Название группы не должно содержать переносы строк.".into(),
        ));
    }
    Ok(trimmed)
}

fn normalize_title_for_patch(raw: &str) -> Result<String, SendMessageError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(SendMessageError::BadRequest(
            "Название группы не может быть пустым.".into(),
        ));
    }
    if trimmed.chars().count() > 40 {
        return Err(SendMessageError::BadRequest(
            "Название группы не длиннее 40 символов.".into(),
        ));
    }
    if trimmed.contains('\n') || trimmed.contains('\r') {
        return Err(SendMessageError::BadRequest(
            "Название группы не должно содержать переносы строк.".into(),
        ));
    }
    Ok(trimmed.to_string())
}

/// Group media v1: voice/image opaque assets only; video lists stay rejected.
fn reject_group_video_assets(video: &[Uuid]) -> Result<(), GroupSendError> {
    if video.is_empty() {
        return Ok(());
    }
    Err(GroupSendError::BadRequest(
        "Видео в групповых сообщениях не поддерживается.".into(),
    ))
}

fn dedupe_uuids(raw: &[Uuid]) -> Vec<Uuid> {
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(raw.len());
    for id in raw {
        if seen.insert(*id) {
            out.push(*id);
        }
    }
    out
}

/// Creator-only roster/title mutations: actor must match `created_by`.
fn require_group_creator(actor: Uuid, created_by: Uuid, action: &str) -> Result<(), SendMessageError> {
    if actor == created_by {
        return Ok(());
    }
    Err(SendMessageError::Forbidden(format!(
        "Только создатель может {action}."
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Always-on guard: badge unread SQL must exclude archived group flags
    /// (smoke with live API is optional / env-gated).
    #[test]
    fn group_unread_sql_excludes_archived_conversation_flags() {
        let src = include_str!("../infrastructure/groups.rs");
        assert!(
            src.contains("group_unread_conversation_count"),
            "missing group unread helper"
        );
        assert!(
            src.contains("user_group_conversation_flags"),
            "unread path must join group archive flags"
        );
        assert!(
            src.contains("f.is_archived = true"),
            "archived groups must be excluded from unread"
        );
        assert!(
            src.contains("AND NOT EXISTS"),
            "exclusion must be NOT EXISTS (not only list filter)"
        );
    }

    #[test]
    fn create_title_defaults_when_empty() {
        assert_eq!(normalize_title_for_create(None).unwrap(), "Группа");
        assert_eq!(normalize_title_for_create(Some("  ")).unwrap(), "Группа");
        assert_eq!(
            normalize_title_for_create(Some("  Команда  ")).unwrap(),
            "Команда"
        );
    }

    #[test]
    fn create_title_rejects_overlong_and_newlines() {
        let long: String = "а".repeat(41);
        assert!(matches!(
            normalize_title_for_create(Some(&long)),
            Err(SendMessageError::BadRequest(_))
        ));
        assert!(matches!(
            normalize_title_for_create(Some("a\nb")),
            Err(SendMessageError::BadRequest(_))
        ));
    }

    #[test]
    fn patch_title_rejects_empty_overlong_newlines() {
        assert!(matches!(
            normalize_title_for_patch("  "),
            Err(SendMessageError::BadRequest(_))
        ));
        let long: String = "б".repeat(41);
        assert!(matches!(
            normalize_title_for_patch(&long),
            Err(SendMessageError::BadRequest(_))
        ));
        assert!(matches!(
            normalize_title_for_patch("x\ry"),
            Err(SendMessageError::BadRequest(_))
        ));
        assert_eq!(normalize_title_for_patch("  Ok  ").unwrap(), "Ok");
    }

    #[test]
    fn group_rejects_video_assets_only() {
        assert!(reject_group_video_assets(&[]).is_ok());
        let id = Uuid::nil();
        assert!(matches!(
            reject_group_video_assets(&[id]),
            Err(GroupSendError::BadRequest(_))
        ));
    }

    #[test]
    fn dedupe_preserves_order() {
        let a = Uuid::from_u128(1);
        let b = Uuid::from_u128(2);
        assert_eq!(dedupe_uuids(&[a, b, a]), vec![a, b]);
    }

    #[test]
    fn creator_acl_helper() {
        let creator = Uuid::from_u128(1);
        let other = Uuid::from_u128(2);
        assert!(require_group_creator(creator, creator, "изменить название группы").is_ok());
        assert!(matches!(
            require_group_creator(other, creator, "изменить название группы"),
            Err(SendMessageError::Forbidden(_))
        ));
    }
}
