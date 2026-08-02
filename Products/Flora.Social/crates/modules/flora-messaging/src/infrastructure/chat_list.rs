//! sqlx: folders + per-peer archive/mute flags (chat list overlay).

use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

#[derive(Debug, Clone, FromRow)]
pub struct ChatFolderRow {
    pub folder_id: Uuid,
    pub kind: String,
    pub label: String,
    pub icon: Option<String>,
    pub avatar_uri: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
pub struct ConversationFlagsRow {
    pub other_user_uuid: Uuid,
    pub is_archived: bool,
    pub is_muted: bool,
}

#[derive(Debug, Clone, FromRow)]
struct FolderMemberRow {
    folder_id: Uuid,
    other_user_uuid: Uuid,
}

pub struct ChatListRepo {
    pool: PgPool,
}

impl ChatListRepo {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn list_folders(&self, owner: Uuid) -> Result<Vec<ChatFolderRow>, String> {
        sqlx::query_as::<_, ChatFolderRow>(
            r#"
            SELECT folder_id, kind, label, icon, avatar_uri, created_at
            FROM flora_core.user_chat_folders
            WHERE owner_user_uuid = $1
            ORDER BY sort_order ASC, created_at ASC
            "#,
        )
        .bind(owner)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn list_all_folder_members(
        &self,
        owner: Uuid,
    ) -> Result<Vec<(Uuid, Uuid)>, String> {
        let rows = sqlx::query_as::<_, FolderMemberRow>(
            r#"
            SELECT folder_id, other_user_uuid
            FROM flora_core.user_chat_folder_members
            WHERE owner_user_uuid = $1
            ORDER BY created_at ASC
            "#,
        )
        .bind(owner)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(rows
            .into_iter()
            .map(|r| (r.folder_id, r.other_user_uuid))
            .collect())
    }

    pub async fn create_folder(
        &self,
        owner: Uuid,
        folder_id: Uuid,
        kind: &str,
        label: &str,
        icon: Option<&str>,
        avatar_uri: Option<&str>,
        member_peer_uuids: &[Uuid],
        now: DateTime<Utc>,
    ) -> Result<(), String> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let sort: i32 = sqlx::query_scalar(
            r#"
            SELECT COALESCE(MAX(sort_order), -1) + 1
            FROM flora_core.user_chat_folders
            WHERE owner_user_uuid = $1
            "#,
        )
        .bind(owner)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        sqlx::query(
            r#"
            INSERT INTO flora_core.user_chat_folders
                (folder_id, owner_user_uuid, kind, label, icon, avatar_uri, sort_order, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
            "#,
        )
        .bind(folder_id)
        .bind(owner)
        .bind(kind)
        .bind(label)
        .bind(icon)
        .bind(avatar_uri)
        .bind(sort)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        for peer in member_peer_uuids {
            if *peer == owner {
                continue;
            }
            sqlx::query(
                r#"
                INSERT INTO flora_core.user_chat_folder_members
                    (folder_id, owner_user_uuid, other_user_uuid, created_at)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT DO NOTHING
                "#,
            )
            .bind(folder_id)
            .bind(owner)
            .bind(peer)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        }

        tx.commit().await.map_err(|e| e.to_string())
    }

    pub async fn delete_folder(&self, owner: Uuid, folder_id: Uuid) -> Result<bool, String> {
        let res = sqlx::query(
            r#"
            DELETE FROM flora_core.user_chat_folders
            WHERE owner_user_uuid = $1 AND folder_id = $2
            "#,
        )
        .bind(owner)
        .bind(folder_id)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(res.rows_affected() > 0)
    }

    pub async fn add_folder_member(
        &self,
        owner: Uuid,
        folder_id: Uuid,
        other_user_uuid: Uuid,
        now: DateTime<Utc>,
    ) -> Result<bool, String> {
        let owned: Option<i32> = sqlx::query_scalar(
            r#"
            SELECT 1
            FROM flora_core.user_chat_folders
            WHERE owner_user_uuid = $1 AND folder_id = $2
            "#,
        )
        .bind(owner)
        .bind(folder_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        if owned.is_none() {
            return Ok(false);
        }
        if other_user_uuid == owner {
            return Err("Нельзя добавить себя в папку.".into());
        }
        sqlx::query(
            r#"
            INSERT INTO flora_core.user_chat_folder_members
                (folder_id, owner_user_uuid, other_user_uuid, created_at)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(folder_id)
        .bind(owner)
        .bind(other_user_uuid)
        .bind(now)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(true)
    }

    pub async fn list_flags(&self, owner: Uuid) -> Result<Vec<ConversationFlagsRow>, String> {
        sqlx::query_as::<_, ConversationFlagsRow>(
            r#"
            SELECT other_user_uuid, is_archived, is_muted
            FROM flora_core.user_conversation_flags
            WHERE owner_user_uuid = $1
            "#,
        )
        .bind(owner)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn count_folders(&self, owner: Uuid) -> Result<i64, String> {
        sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM flora_core.user_chat_folders
            WHERE owner_user_uuid = $1
            "#,
        )
        .bind(owner)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn count_archived(&self, owner: Uuid) -> Result<i64, String> {
        sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM flora_core.user_conversation_flags
            WHERE owner_user_uuid = $1 AND is_archived = true
            "#,
        )
        .bind(owner)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn is_peer_archived(&self, owner: Uuid, other: Uuid) -> Result<bool, String> {
        let row: Option<bool> = sqlx::query_scalar(
            r#"
            SELECT is_archived
            FROM flora_core.user_conversation_flags
            WHERE owner_user_uuid = $1 AND other_user_uuid = $2
            "#,
        )
        .bind(owner)
        .bind(other)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(row.unwrap_or(false))
    }

    pub async fn set_archived(
        &self,
        owner: Uuid,
        other: Uuid,
        archived: bool,
        now: DateTime<Utc>,
    ) -> Result<(), String> {
        self.upsert_flag(owner, other, Some(archived), None, now)
            .await
    }

    pub async fn set_muted(
        &self,
        owner: Uuid,
        other: Uuid,
        muted: bool,
        now: DateTime<Utc>,
    ) -> Result<(), String> {
        self.upsert_flag(owner, other, None, Some(muted), now).await
    }

    async fn upsert_flag(
        &self,
        owner: Uuid,
        other: Uuid,
        archived: Option<bool>,
        muted: Option<bool>,
        now: DateTime<Utc>,
    ) -> Result<(), String> {
        if other == owner {
            return Err("Некорректный собеседник.".into());
        }
        let row = sqlx::query_as::<_, ConversationFlagsRow>(
            r#"
            SELECT other_user_uuid, is_archived, is_muted
            FROM flora_core.user_conversation_flags
            WHERE owner_user_uuid = $1 AND other_user_uuid = $2
            "#,
        )
        .bind(owner)
        .bind(other)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        let (is_archived, is_muted) = match row {
            Some(r) => (
                archived.unwrap_or(r.is_archived),
                muted.unwrap_or(r.is_muted),
            ),
            None => (archived.unwrap_or(false), muted.unwrap_or(false)),
        };

        if !is_archived && !is_muted {
            sqlx::query(
                r#"
                DELETE FROM flora_core.user_conversation_flags
                WHERE owner_user_uuid = $1 AND other_user_uuid = $2
                "#,
            )
            .bind(owner)
            .bind(other)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
            return Ok(());
        }

        sqlx::query(
            r#"
            INSERT INTO flora_core.user_conversation_flags
                (owner_user_uuid, other_user_uuid, is_archived, is_muted, updated_at)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (owner_user_uuid, other_user_uuid) DO UPDATE SET
                is_archived = EXCLUDED.is_archived,
                is_muted = EXCLUDED.is_muted,
                updated_at = EXCLUDED.updated_at
            "#,
        )
        .bind(owner)
        .bind(other)
        .bind(is_archived)
        .bind(is_muted)
        .bind(now)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}
