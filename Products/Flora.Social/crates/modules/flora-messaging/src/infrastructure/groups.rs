//! SQL for FSCP-G group conversations / members / messages / reads.

use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

pub struct GroupRepo {
    pool: PgPool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct GroupConversationRow {
    pub conversation_uuid: Uuid,
    pub title: String,
    pub created_by_user_uuid: Uuid,
    pub created_at: DateTime<Utc>,
    pub current_key_epoch_id: Uuid,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct GroupMemberRow {
    pub conversation_uuid: Uuid,
    pub user_uuid: Uuid,
    pub joined_at: DateTime<Utc>,
    pub left_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct GroupMessageRow {
    pub message_uuid: Uuid,
    pub conversation_uuid: Uuid,
    pub sender_user_uuid: Uuid,
    pub encrypted_wire: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct GroupListScanRow {
    pub conversation_uuid: Uuid,
    pub title: String,
    pub created_by_user_uuid: Uuid,
    pub created_at: DateTime<Utc>,
    pub member_count: i32,
    pub last_message_encrypted_wire: Option<String>,
    pub last_message_at: Option<DateTime<Utc>>,
    pub last_message_sender: Option<Uuid>,
    pub unread_count: i32,
}

impl GroupRepo {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn begin(&self) -> Result<Transaction<'_, Postgres>, String> {
        self.pool.begin().await.map_err(|e| e.to_string())
    }

    pub async fn insert_conversation(
        tx: &mut Transaction<'_, Postgres>,
        conversation_uuid: Uuid,
        title: &str,
        created_by: Uuid,
        key_epoch_id: Uuid,
        created_at: DateTime<Utc>,
    ) -> Result<(), String> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.group_conversations
                (conversation_uuid, title, created_by_user_uuid, created_at, current_key_epoch_id)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(conversation_uuid)
        .bind(title)
        .bind(created_by)
        .bind(created_at)
        .bind(key_epoch_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn upsert_member_active(
        tx: &mut Transaction<'_, Postgres>,
        conversation_uuid: Uuid,
        user_uuid: Uuid,
        joined_at: DateTime<Utc>,
    ) -> Result<(), String> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.group_members
                (conversation_uuid, user_uuid, joined_at, left_at)
            VALUES ($1, $2, $3, NULL)
            ON CONFLICT (conversation_uuid, user_uuid) DO UPDATE
                SET joined_at = EXCLUDED.joined_at, left_at = NULL
            "#,
        )
        .bind(conversation_uuid)
        .bind(user_uuid)
        .bind(joined_at)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn set_member_left(
        &self,
        conversation_uuid: Uuid,
        user_uuid: Uuid,
        left_at: DateTime<Utc>,
    ) -> Result<bool, String> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let res = sqlx::query(
            r#"
            UPDATE flora_core.group_members
            SET left_at = $3
            WHERE conversation_uuid = $1 AND user_uuid = $2 AND left_at IS NULL
            "#,
        )
        .bind(conversation_uuid)
        .bind(user_uuid)
        .bind(left_at)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        if res.rows_affected() == 0 {
            return Ok(false);
        }
        // Drop badge/LIMIT projection so rejoin does not suppress unread forever.
        sqlx::query(
            r#"
            DELETE FROM flora_core.user_group_conversation_flags
            WHERE owner_user_uuid = $1 AND conversation_uuid = $2
            "#,
        )
        .bind(user_uuid)
        .bind(conversation_uuid)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(true)
    }

    pub async fn list_archived_group_conversation_uuids(
        &self,
        owner: Uuid,
    ) -> Result<Vec<Uuid>, String> {
        sqlx::query_scalar(
            r#"
            SELECT conversation_uuid
            FROM flora_core.user_group_conversation_flags
            WHERE owner_user_uuid = $1 AND is_archived = true
            "#,
        )
        .bind(owner)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }

    /// Archive under per-owner xact lock when introducing Archive icon slot.
    /// `max_folder_icons` matches DM chat-list LIMIT (4).
    pub async fn set_group_archived_checked(
        &self,
        owner: Uuid,
        conversation_uuid: Uuid,
        archived: bool,
        now: DateTime<Utc>,
        max_folder_icons: i64,
    ) -> Result<(), String> {
        let membership = self
            .active_membership(conversation_uuid, owner)
            .await?;
        if membership.is_none() {
            return Err("NOT_FOUND:Группа не найдена.".into());
        }

        if !archived {
            return self.clear_or_unarchive_group_flag(owner, conversation_uuid, now).await;
        }

        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        sqlx::query("SELECT pg_advisory_xact_lock(88442201, hashtext($1::text))")
            .bind(owner)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;

        let already: bool = sqlx::query_scalar(
            r#"
            SELECT COALESCE(
                (SELECT is_archived
                 FROM flora_core.user_group_conversation_flags
                 WHERE owner_user_uuid = $1 AND conversation_uuid = $2),
                false
            )
            "#,
        )
        .bind(owner)
        .bind(conversation_uuid)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        if !already {
            let custom_count: i64 = sqlx::query_scalar(
                r#"
                SELECT COUNT(*)::bigint
                FROM flora_core.user_chat_folders
                WHERE owner_user_uuid = $1
                "#,
            )
            .bind(owner)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
            let any_archive: bool = sqlx::query_scalar(
                r#"
                SELECT EXISTS (
                    SELECT 1 FROM flora_core.user_conversation_flags
                    WHERE owner_user_uuid = $1 AND is_archived = true
                ) OR EXISTS (
                    SELECT 1 FROM flora_core.user_group_conversation_flags
                    WHERE owner_user_uuid = $1 AND is_archived = true
                )
                "#,
            )
            .bind(owner)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
            if !any_archive && custom_count >= max_folder_icons {
                return Err(
                    "LIMIT:Нельзя архивировать: уже заняты все четыре слота иконок. Удалите папку, чтобы освободить место для Архива."
                        .into(),
                );
            }
        }

        let is_muted: bool = sqlx::query_scalar(
            r#"
            SELECT COALESCE(
                (SELECT is_muted
                 FROM flora_core.user_group_conversation_flags
                 WHERE owner_user_uuid = $1 AND conversation_uuid = $2),
                false
            )
            "#,
        )
        .bind(owner)
        .bind(conversation_uuid)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        sqlx::query(
            r#"
            INSERT INTO flora_core.user_group_conversation_flags
                (owner_user_uuid, conversation_uuid, is_archived, is_muted, updated_at)
            VALUES ($1, $2, true, $3, $4)
            ON CONFLICT (owner_user_uuid, conversation_uuid) DO UPDATE SET
                is_archived = true,
                is_muted = EXCLUDED.is_muted,
                updated_at = EXCLUDED.updated_at
            "#,
        )
        .bind(owner)
        .bind(conversation_uuid)
        .bind(is_muted)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        tx.commit().await.map_err(|e| e.to_string())
    }

    async fn clear_or_unarchive_group_flag(
        &self,
        owner: Uuid,
        conversation_uuid: Uuid,
        now: DateTime<Utc>,
    ) -> Result<(), String> {
        let is_muted: Option<bool> = sqlx::query_scalar(
            r#"
            SELECT is_muted
            FROM flora_core.user_group_conversation_flags
            WHERE owner_user_uuid = $1 AND conversation_uuid = $2
            "#,
        )
        .bind(owner)
        .bind(conversation_uuid)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        match is_muted {
            None => Ok(()),
            Some(true) => {
                sqlx::query(
                    r#"
                    UPDATE flora_core.user_group_conversation_flags
                    SET is_archived = false, updated_at = $3
                    WHERE owner_user_uuid = $1 AND conversation_uuid = $2
                    "#,
                )
                .bind(owner)
                .bind(conversation_uuid)
                .bind(now)
                .execute(&self.pool)
                .await
                .map_err(|e| e.to_string())?;
                Ok(())
            }
            Some(false) => {
                sqlx::query(
                    r#"
                    DELETE FROM flora_core.user_group_conversation_flags
                    WHERE owner_user_uuid = $1 AND conversation_uuid = $2
                    "#,
                )
                .bind(owner)
                .bind(conversation_uuid)
                .execute(&self.pool)
                .await
                .map_err(|e| e.to_string())?;
                Ok(())
            }
        }
    }

    pub async fn get_conversation(
        &self,
        conversation_uuid: Uuid,
    ) -> Result<Option<GroupConversationRow>, String> {
        sqlx::query_as(
            r#"
            SELECT conversation_uuid, title, created_by_user_uuid, created_at, current_key_epoch_id
            FROM flora_core.group_conversations
            WHERE conversation_uuid = $1
            "#,
        )
        .bind(conversation_uuid)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn update_title(
        &self,
        conversation_uuid: Uuid,
        title: &str,
    ) -> Result<bool, String> {
        let res = sqlx::query(
            r#"
            UPDATE flora_core.group_conversations
            SET title = $2
            WHERE conversation_uuid = $1
            "#,
        )
        .bind(conversation_uuid)
        .bind(title)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(res.rows_affected() > 0)
    }

    /// Active members, locked for update (send path TOCTOU).
    pub async fn lock_active_member_uuids(
        tx: &mut Transaction<'_, Postgres>,
        conversation_uuid: Uuid,
    ) -> Result<Vec<Uuid>, String> {
        let rows: Vec<(Uuid,)> = sqlx::query_as(
            r#"
            SELECT user_uuid
            FROM flora_core.group_members
            WHERE conversation_uuid = $1 AND left_at IS NULL
            ORDER BY user_uuid
            FOR UPDATE
            "#,
        )
        .bind(conversation_uuid)
        .fetch_all(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(|(u,)| u).collect())
    }

    pub async fn active_member_uuids(&self, conversation_uuid: Uuid) -> Result<Vec<Uuid>, String> {
        let rows: Vec<(Uuid,)> = sqlx::query_as(
            r#"
            SELECT user_uuid
            FROM flora_core.group_members
            WHERE conversation_uuid = $1 AND left_at IS NULL
            ORDER BY user_uuid
            "#,
        )
        .bind(conversation_uuid)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(|(u,)| u).collect())
    }

    pub async fn active_membership(
        &self,
        conversation_uuid: Uuid,
        user_uuid: Uuid,
    ) -> Result<Option<GroupMemberRow>, String> {
        sqlx::query_as(
            r#"
            SELECT conversation_uuid, user_uuid, joined_at, left_at
            FROM flora_core.group_members
            WHERE conversation_uuid = $1 AND user_uuid = $2 AND left_at IS NULL
            "#,
        )
        .bind(conversation_uuid)
        .bind(user_uuid)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn list_active_members(
        &self,
        conversation_uuid: Uuid,
    ) -> Result<Vec<GroupMemberRow>, String> {
        sqlx::query_as(
            r#"
            SELECT conversation_uuid, user_uuid, joined_at, left_at
            FROM flora_core.group_members
            WHERE conversation_uuid = $1 AND left_at IS NULL
            ORDER BY joined_at ASC, user_uuid ASC
            "#,
        )
        .bind(conversation_uuid)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn insert_message(
        tx: &mut Transaction<'_, Postgres>,
        message_uuid: Uuid,
        conversation_uuid: Uuid,
        sender_user_uuid: Uuid,
        encrypted_wire: &str,
        created_at: DateTime<Utc>,
    ) -> Result<InsertMessageOutcome, String> {
        let existing: Option<(String, DateTime<Utc>)> = sqlx::query_as(
            r#"
            SELECT encrypted_wire, created_at
            FROM flora_core.group_messages
            WHERE conversation_uuid = $1 AND message_uuid = $2
            "#,
        )
        .bind(conversation_uuid)
        .bind(message_uuid)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;

        if let Some((wire, at)) = existing {
            if wire == encrypted_wire {
                return Ok(InsertMessageOutcome::Idempotent {
                    created_at: at,
                    encrypted_wire: wire,
                });
            }
            return Ok(InsertMessageOutcome::Conflict);
        }

        sqlx::query(
            r#"
            INSERT INTO flora_core.group_messages
                (message_uuid, conversation_uuid, sender_user_uuid, encrypted_wire, created_at)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(message_uuid)
        .bind(conversation_uuid)
        .bind(sender_user_uuid)
        .bind(encrypted_wire)
        .bind(created_at)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;

        Ok(InsertMessageOutcome::Inserted { created_at })
    }

    /// Bind unbound group voice assets owned by `uploader` in this conversation.
    pub async fn bind_voice_assets(
        tx: &mut Transaction<'_, Postgres>,
        message_uuid: Uuid,
        conversation_uuid: Uuid,
        uploader: Uuid,
        asset_uuids: &[Uuid],
    ) -> Result<(), String> {
        if asset_uuids.is_empty() {
            return Ok(());
        }
        let bound = sqlx::query(
            r#"
            UPDATE flora_core.group_message_voice_assets
            SET message_uuid = $1
            WHERE voice_asset_uuid = ANY($2)
              AND conversation_uuid = $3
              AND uploader_user_uuid = $4
              AND message_uuid IS NULL
            "#,
        )
        .bind(message_uuid)
        .bind(asset_uuids)
        .bind(conversation_uuid)
        .bind(uploader)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        if bound.rows_affected() != asset_uuids.len() as u64 {
            return Err(
                "Голосовое вложение не принадлежит этому черновику группы или уже отправлено."
                    .into(),
            );
        }
        Ok(())
    }

    /// Bind unbound group image assets owned by `uploader` in this conversation.
    pub async fn bind_image_assets(
        tx: &mut Transaction<'_, Postgres>,
        message_uuid: Uuid,
        conversation_uuid: Uuid,
        uploader: Uuid,
        asset_uuids: &[Uuid],
    ) -> Result<(), String> {
        if asset_uuids.is_empty() {
            return Ok(());
        }
        let bound = sqlx::query(
            r#"
            UPDATE flora_core.group_message_image_assets
            SET message_uuid = $1
            WHERE image_asset_uuid = ANY($2)
              AND conversation_uuid = $3
              AND uploader_user_uuid = $4
              AND message_uuid IS NULL
            "#,
        )
        .bind(message_uuid)
        .bind(asset_uuids)
        .bind(conversation_uuid)
        .bind(uploader)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        if bound.rows_affected() != asset_uuids.len() as u64 {
            return Err(
                "Фото-вложение не принадлежит этому черновику группы или уже отправлено.".into(),
            );
        }
        Ok(())
    }

    /// True when every listed asset is already bound to `message_uuid` (idempotent resend).
    pub async fn assets_already_bound_to_message(
        tx: &mut Transaction<'_, Postgres>,
        message_uuid: Uuid,
        conversation_uuid: Uuid,
        voice_uuids: &[Uuid],
        image_uuids: &[Uuid],
    ) -> Result<bool, String> {
        if !voice_uuids.is_empty() {
            let n: i64 = sqlx::query_scalar(
                r#"
                SELECT COUNT(*)::bigint
                FROM flora_core.group_message_voice_assets
                WHERE voice_asset_uuid = ANY($1)
                  AND conversation_uuid = $2
                  AND message_uuid = $3
                "#,
            )
            .bind(voice_uuids)
            .bind(conversation_uuid)
            .bind(message_uuid)
            .fetch_one(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
            if n != voice_uuids.len() as i64 {
                return Ok(false);
            }
        }
        if !image_uuids.is_empty() {
            let n: i64 = sqlx::query_scalar(
                r#"
                SELECT COUNT(*)::bigint
                FROM flora_core.group_message_image_assets
                WHERE image_asset_uuid = ANY($1)
                  AND conversation_uuid = $2
                  AND message_uuid = $3
                "#,
            )
            .bind(image_uuids)
            .bind(conversation_uuid)
            .bind(message_uuid)
            .fetch_one(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
            if n != image_uuids.len() as i64 {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub async fn messages_page(
        &self,
        conversation_uuid: Uuid,
        joined_at: DateTime<Utc>,
        cursor_before: Option<DateTime<Utc>>,
        take: i32,
    ) -> Result<Vec<GroupMessageRow>, String> {
        let take = take.clamp(1, 100);
        let rows: Vec<GroupMessageRow> = if let Some(before) = cursor_before {
            sqlx::query_as(
                r#"
                SELECT message_uuid, conversation_uuid, sender_user_uuid, encrypted_wire, created_at
                FROM flora_core.group_messages
                WHERE conversation_uuid = $1
                  AND created_at >= $2
                  AND created_at < $3
                ORDER BY created_at DESC
                LIMIT $4
                "#,
            )
            .bind(conversation_uuid)
            .bind(joined_at)
            .bind(before)
            .bind(take)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string())?
        } else {
            sqlx::query_as(
                r#"
                SELECT message_uuid, conversation_uuid, sender_user_uuid, encrypted_wire, created_at
                FROM flora_core.group_messages
                WHERE conversation_uuid = $1
                  AND created_at >= $2
                ORDER BY created_at DESC
                LIMIT $3
                "#,
            )
            .bind(conversation_uuid)
            .bind(joined_at)
            .bind(take)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string())?
        };
        Ok(rows)
    }

    pub async fn upsert_read(
        &self,
        conversation_uuid: Uuid,
        user_uuid: Uuid,
        last_read_at: DateTime<Utc>,
    ) -> Result<(), String> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.group_message_reads
                (conversation_uuid, user_uuid, last_read_at)
            VALUES ($1, $2, $3)
            ON CONFLICT (conversation_uuid, user_uuid) DO UPDATE
                SET last_read_at = GREATEST(
                    flora_core.group_message_reads.last_read_at,
                    EXCLUDED.last_read_at
                )
            "#,
        )
        .bind(conversation_uuid)
        .bind(user_uuid)
        .bind(last_read_at)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn group_unread_conversation_count(&self, user_uuid: Uuid) -> Result<i64, String> {
        sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM flora_core.group_members m
            WHERE m.user_uuid = $1 AND m.left_at IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM flora_core.user_group_conversation_flags f
                WHERE f.owner_user_uuid = m.user_uuid
                  AND f.conversation_uuid = m.conversation_uuid
                  AND f.is_archived = true
              )
              AND EXISTS (
                SELECT 1
                FROM flora_core.group_messages msg
                LEFT JOIN flora_core.group_message_reads r
                  ON r.conversation_uuid = m.conversation_uuid
                 AND r.user_uuid = m.user_uuid
                WHERE msg.conversation_uuid = m.conversation_uuid
                  AND msg.created_at >= m.joined_at
                  AND msg.sender_user_uuid <> $1
                  AND (r.last_read_at IS NULL OR msg.created_at > r.last_read_at)
              )
            "#,
        )
        .bind(user_uuid)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn list_groups_for_user(&self, user_uuid: Uuid) -> Result<Vec<GroupListScanRow>, String> {
        let rows: Vec<GroupListSqlRow> = sqlx::query_as(
            r#"
            SELECT
                c.conversation_uuid,
                c.title,
                c.created_by_user_uuid,
                c.created_at,
                (
                    SELECT COUNT(*)::int
                    FROM flora_core.group_members am
                    WHERE am.conversation_uuid = c.conversation_uuid AND am.left_at IS NULL
                ) AS member_count,
                lm.encrypted_wire AS last_message_encrypted_wire,
                lm.created_at AS last_message_at,
                lm.sender_user_uuid AS last_message_sender,
                (
                    SELECT COUNT(*)::int
                    FROM flora_core.group_messages msg
                    LEFT JOIN flora_core.group_message_reads r
                      ON r.conversation_uuid = m.conversation_uuid
                     AND r.user_uuid = m.user_uuid
                    WHERE msg.conversation_uuid = m.conversation_uuid
                      AND msg.created_at >= m.joined_at
                      AND msg.sender_user_uuid <> $1
                      AND (r.last_read_at IS NULL OR msg.created_at > r.last_read_at)
                ) AS unread_count
            FROM flora_core.group_members m
            INNER JOIN flora_core.group_conversations c
                ON c.conversation_uuid = m.conversation_uuid
            LEFT JOIN LATERAL (
                SELECT msg.encrypted_wire, msg.created_at, msg.sender_user_uuid
                FROM flora_core.group_messages msg
                WHERE msg.conversation_uuid = m.conversation_uuid
                  AND msg.created_at >= m.joined_at
                ORDER BY msg.created_at DESC
                LIMIT 1
            ) lm ON TRUE
            WHERE m.user_uuid = $1 AND m.left_at IS NULL
            ORDER BY COALESCE(lm.created_at, c.created_at) DESC
            LIMIT 100
            "#,
        )
        .bind(user_uuid)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        Ok(rows
            .into_iter()
            .map(|r| GroupListScanRow {
                conversation_uuid: r.conversation_uuid,
                title: r.title,
                created_by_user_uuid: r.created_by_user_uuid,
                created_at: r.created_at,
                member_count: r.member_count,
                last_message_encrypted_wire: r.last_message_encrypted_wire,
                last_message_at: r.last_message_at,
                last_message_sender: r.last_message_sender,
                unread_count: r.unread_count,
            })
            .collect())
    }
}

#[derive(Debug, Clone)]
pub enum InsertMessageOutcome {
    Inserted { created_at: DateTime<Utc> },
    Idempotent {
        created_at: DateTime<Utc>,
        encrypted_wire: String,
    },
    Conflict,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct GroupListSqlRow {
    conversation_uuid: Uuid,
    title: String,
    created_by_user_uuid: Uuid,
    created_at: DateTime<Utc>,
    member_count: i32,
    last_message_encrypted_wire: Option<String>,
    last_message_at: Option<DateTime<Utc>>,
    last_message_sender: Option<Uuid>,
    unread_count: i32,
}
