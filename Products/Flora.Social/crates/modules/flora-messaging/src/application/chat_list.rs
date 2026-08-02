//! Chat list overlay: folders (+ members) and per-peer archive/mute. No FSCP.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{SecondsFormat, Utc};
use flora_messaging_contracts::{
    AddChatFolderMemberRequest, ChatListEntityDto, ChatListEntityKindDto, ChatListOverlayDto,
    CreateChatFolderRequest,
};
use flora_shared::uuid_v5::dm_conversation_uuid;
use uuid::Uuid;

use crate::infrastructure::ChatListRepo;

/// Совпадает с `CHAT_LIST_MAX_FOLDER_ICONS` в `@flora/client-core/messaging`.
const CHAT_LIST_MAX_FOLDER_ICONS: i64 = 4;

/// Wire-имена из `CHAT_LIST_FOLDER_ICON_NAMES` (client-core).
const CHAT_LIST_FOLDER_ICONS: &[&str] = &[
    "folder-outline",
    "briefcase-outline",
    "heart-outline",
    "star-outline",
    "flash-outline",
    "home-outline",
    "game-controller-outline",
    "musical-notes-outline",
    "airplane-outline",
    "cafe-outline",
    "book-outline",
    "construct-outline",
];

#[derive(Debug, Clone)]
pub enum ChatListError {
    BadRequest(String),
    NotFound(String),
    Internal(String),
}

fn map_repo_err(e: String) -> ChatListError {
    if let Some(msg) = e.strip_prefix("LIMIT:") {
        ChatListError::BadRequest(msg.to_string())
    } else if e.contains("Некорректный") {
        ChatListError::BadRequest(e)
    } else {
        ChatListError::Internal(e)
    }
}

fn is_allowed_folder_icon(icon: &str) -> bool {
    CHAT_LIST_FOLDER_ICONS.contains(&icon)
}

pub struct ChatListService {
    repo: Arc<ChatListRepo>,
}

impl ChatListService {
    pub fn new(repo: Arc<ChatListRepo>) -> Self {
        Self { repo }
    }

    pub async fn overlay(&self, owner: Uuid) -> Result<ChatListOverlayDto, ChatListError> {
        let folders = self
            .repo
            .list_folders(owner)
            .await
            .map_err(ChatListError::Internal)?;
        let members = self
            .repo
            .list_all_folder_members(owner)
            .await
            .map_err(ChatListError::Internal)?;
        let mut members_by_folder: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
        for (folder_id, peer) in members {
            members_by_folder.entry(folder_id).or_default().push(peer);
        }

        let mut entities = Vec::with_capacity(folders.len());
        for row in folders {
            let kind = match row.kind.as_str() {
                "folder" => ChatListEntityKindDto::Folder,
                "group" => ChatListEntityKindDto::Group,
                _ => continue,
            };
            entities.push(ChatListEntityDto {
                id: row.folder_id,
                kind,
                label: row.label,
                icon: row.icon,
                avatar_uri: row.avatar_uri,
                member_peer_uuids: members_by_folder.remove(&row.folder_id).unwrap_or_default(),
                created_at: row.created_at.to_rfc3339_opts(SecondsFormat::Millis, true),
            });
        }

        let flags = self
            .repo
            .list_flags(owner)
            .await
            .map_err(ChatListError::Internal)?;
        let mut archived_peer_uuids = Vec::new();
        let mut muted_peer_uuids = Vec::new();
        for f in flags {
            if f.is_archived {
                archived_peer_uuids.push(f.other_user_uuid);
            }
            if f.is_muted {
                muted_peer_uuids.push(f.other_user_uuid);
            }
        }

        Ok(ChatListOverlayDto {
            entities,
            archived_peer_uuids,
            muted_peer_uuids,
        })
    }

    pub async fn create_folder(
        &self,
        owner: Uuid,
        req: CreateChatFolderRequest,
    ) -> Result<ChatListEntityDto, ChatListError> {
        let label = req.label.trim().to_string();
        if label.is_empty() || label.len() > 80 {
            return Err(ChatListError::BadRequest(
                "Название папки: 1–80 символов.".into(),
            ));
        }
        let kind_dto = req.kind;
        let kind = match &kind_dto {
            ChatListEntityKindDto::Folder => "folder",
            ChatListEntityKindDto::Group => {
                return Err(ChatListError::BadRequest("Группы пока недоступны.".into()));
            }
        };
        let folder_id = Uuid::now_v7();
        let now = Utc::now();
        let members: Vec<Uuid> = req
            .member_peer_uuids
            .into_iter()
            .filter(|u| !u.is_nil() && *u != owner)
            .collect();
        let icon = req
            .icon
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        if let Some(ref name) = icon
            && !is_allowed_folder_icon(name)
        {
            return Err(ChatListError::BadRequest(
                "Недопустимая иконка папки.".into(),
            ));
        }
        let avatar_uri = req
            .avatar_uri
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        self.repo
            .create_folder(
                owner,
                folder_id,
                kind,
                &label,
                icon.as_deref(),
                avatar_uri.as_deref(),
                &members,
                now,
                CHAT_LIST_MAX_FOLDER_ICONS,
            )
            .await
            .map_err(map_repo_err)?;

        Ok(ChatListEntityDto {
            id: folder_id,
            kind: kind_dto,
            label,
            icon,
            avatar_uri,
            member_peer_uuids: members,
            created_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
        })
    }

    pub async fn delete_folder(&self, owner: Uuid, folder_id: Uuid) -> Result<(), ChatListError> {
        let ok = self
            .repo
            .delete_folder(owner, folder_id)
            .await
            .map_err(ChatListError::Internal)?;
        if !ok {
            return Err(ChatListError::NotFound("Папка не найдена.".into()));
        }
        Ok(())
    }

    pub async fn add_folder_member(
        &self,
        owner: Uuid,
        folder_id: Uuid,
        req: AddChatFolderMemberRequest,
    ) -> Result<(), ChatListError> {
        if req.other_user_uuid.is_nil() || req.other_user_uuid == owner {
            return Err(ChatListError::BadRequest("Некорректный собеседник.".into()));
        }
        let ok = self
            .repo
            .add_folder_member(owner, folder_id, req.other_user_uuid, Utc::now())
            .await
            .map_err(|e| {
                if e.contains("Нельзя") {
                    ChatListError::BadRequest(e)
                } else {
                    ChatListError::Internal(e)
                }
            })?;
        if !ok {
            return Err(ChatListError::NotFound("Папка не найдена.".into()));
        }
        Ok(())
    }

    pub async fn set_archived(
        &self,
        owner: Uuid,
        conversation_uuid: Uuid,
        other_user_uuid: Uuid,
        archived: bool,
    ) -> Result<(), ChatListError> {
        let other = require_peer(owner, conversation_uuid, other_user_uuid)?;
        self.repo
            .set_archived_checked(
                owner,
                other,
                archived,
                Utc::now(),
                CHAT_LIST_MAX_FOLDER_ICONS,
            )
            .await
            .map_err(map_repo_err)
    }

    pub async fn set_muted(
        &self,
        owner: Uuid,
        conversation_uuid: Uuid,
        other_user_uuid: Uuid,
        muted: bool,
    ) -> Result<(), ChatListError> {
        let other = require_peer(owner, conversation_uuid, other_user_uuid)?;
        self.repo
            .set_muted(owner, other, muted, Utc::now())
            .await
            .map_err(|e| {
                if e.contains("Некорректный") {
                    ChatListError::BadRequest(e)
                } else {
                    ChatListError::Internal(e)
                }
            })
    }
}

fn require_peer(
    owner: Uuid,
    conversation_uuid: Uuid,
    other_user_uuid: Uuid,
) -> Result<Uuid, ChatListError> {
    if other_user_uuid.is_nil() || other_user_uuid == owner {
        return Err(ChatListError::BadRequest(
            "Укажите otherUserUuid собеседника.".into(),
        ));
    }
    if dm_conversation_uuid(&owner, &other_user_uuid) != conversation_uuid {
        return Err(ChatListError::BadRequest(
            "conversationUuid не совпадает с участниками.".into(),
        ));
    }
    Ok(other_user_uuid)
}
