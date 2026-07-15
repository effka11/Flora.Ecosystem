//! Репозиторий диалогов — паритет `ConversationRepository` (C#).

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use flora_messaging_contracts::{ConversationPeerRow, DeleteConversationOutcome, DeleteMessageOutcome};
use sqlx::PgPool;
use uuid::Uuid;

pub struct MessagingRepo {
    pool: PgPool,
}

/// Строка сообщения до сериализации (C# `MessageRow`).
#[derive(Debug, Clone)]
pub struct MessageRow {
    pub message_uuid: Uuid,
    pub sender_user_uuid: Uuid,
    pub encrypted_for_me: Option<String>,
    pub content: Option<String>,
    pub created_at: DateTime<Utc>,
    pub is_read: bool,
    pub is_from_me: bool,
    pub voice_asset_uuids: Vec<Uuid>,
    pub image_asset_uuids: Vec<Uuid>,
    pub video_asset_uuids: Vec<Uuid>,
}

/// Результат отправки сообщения.
#[derive(Debug, Clone)]
pub struct SendMessageRow {
    pub message_uuid: Uuid,
    pub created_at: DateTime<Utc>,
    pub encrypted_for_sender: String,
}

impl MessagingRepo {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Число чатов с непрочитанным (distinct sender), не число сообщений.
    pub async fn total_unread_count(&self, user_uuid: Uuid) -> Result<i64, String> {
        sqlx::query_scalar(
            r#"
            SELECT COUNT(DISTINCT sender_user_uuid)::bigint
            FROM flora_core.user_messages
            WHERE receiver_user_uuid = $1 AND is_read = false
            "#,
        )
        .bind(user_uuid)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }

    /// Все peer-сводки для пользователя, newest last-message first.
    pub async fn peer_rows(&self, user_uuid: Uuid) -> Result<Vec<ConversationPeerRow>, String> {
        let rows: Vec<MessageScanRow> = sqlx::query_as(
            r#"
            SELECT message_uuid, sender_user_uuid, receiver_user_uuid,
                   content, encrypted_for_receiver, encrypted_for_sender,
                   created_at, is_read
            FROM flora_core.user_messages
            WHERE sender_user_uuid = $1 OR receiver_user_uuid = $1
            ORDER BY created_at DESC
            "#,
        )
        .bind(user_uuid)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        let mut last_by_other: HashMap<Uuid, LastPeer> = HashMap::new();
        let mut unread_by_other: HashMap<Uuid, i32> = HashMap::new();

        for m in rows {
            let is_from_me = m.sender_user_uuid == user_uuid;
            let other = if is_from_me {
                m.receiver_user_uuid
            } else {
                m.sender_user_uuid
            };

            last_by_other.entry(other).or_insert(LastPeer {
                message_uuid: m.message_uuid,
                content: m.content,
                enc_receiver: m.encrypted_for_receiver,
                enc_sender: m.encrypted_for_sender,
                at: m.created_at,
                from_me: is_from_me,
            });

            if !is_from_me && !m.is_read {
                *unread_by_other.entry(other).or_insert(0) += 1;
            }
        }

        let mut peers: Vec<ConversationPeerRow> = last_by_other
            .into_iter()
            .map(|(other, last)| {
                let enc_for_me = if last.from_me {
                    last.enc_sender
                } else {
                    last.enc_receiver
                };
                let last_content = last
                    .content
                    .filter(|c| !c.is_empty());
                ConversationPeerRow {
                    other_user_uuid: other,
                    last_message_uuid: last.message_uuid,
                    last_encrypted_for_me: enc_for_me,
                    last_content,
                    last_message_at: last.at,
                    last_is_from_me: last.from_me,
                    unread_count: unread_by_other.get(&other).copied().unwrap_or(0),
                }
            })
            .collect();

        peers.sort_by(|a, b| b.last_message_at.cmp(&a.last_message_at));
        Ok(peers)
    }

    /// Offset/limit page — паритет legacy `GET /api/auth/conversations/with/{other}` (skip/take).
    pub async fn messages_offset_page(
        &self,
        user_uuid: Uuid,
        other_user_uuid: Uuid,
        skip: usize,
        take: usize,
    ) -> Result<Vec<MessageRow>, String> {
        let rows: Vec<MessageScanRow> = sqlx::query_as(
            r#"
            SELECT message_uuid, sender_user_uuid, receiver_user_uuid,
                   content, encrypted_for_receiver, encrypted_for_sender,
                   created_at, is_read
            FROM flora_core.user_messages
            WHERE (sender_user_uuid = $1 AND receiver_user_uuid = $2)
               OR (sender_user_uuid = $2 AND receiver_user_uuid = $1)
            ORDER BY created_at DESC
            OFFSET $3
            LIMIT $4
            "#,
        )
        .bind(user_uuid)
        .bind(other_user_uuid)
        .bind(skip as i64)
        .bind(take as i64)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        Ok(rows
            .into_iter()
            .map(|m| {
                let is_from_me = m.sender_user_uuid == user_uuid;
                let encrypted_for_me = if is_from_me {
                    m.encrypted_for_sender
                } else {
                    m.encrypted_for_receiver
                };
                MessageRow {
                    message_uuid: m.message_uuid,
                    sender_user_uuid: m.sender_user_uuid,
                    encrypted_for_me,
                    content: m.content,
                    created_at: m.created_at,
                    is_read: m.is_read,
                    is_from_me,
                    voice_asset_uuids: Vec::new(),
                    image_asset_uuids: Vec::new(),
                    video_asset_uuids: Vec::new(),
                }
            })
            .collect())
    }

    pub async fn messages_page(
        &self,
        user_uuid: Uuid,
        other_user_uuid: Uuid,
        cursor_at: Option<DateTime<Utc>>,
        take: usize,
    ) -> Result<Vec<MessageRow>, String> {
        let rows: Vec<MessageScanRow> = if let Some(at) = cursor_at {
            sqlx::query_as(
                r#"
                SELECT message_uuid, sender_user_uuid, receiver_user_uuid,
                       content, encrypted_for_receiver, encrypted_for_sender,
                       created_at, is_read
                FROM flora_core.user_messages
                WHERE ((sender_user_uuid = $1 AND receiver_user_uuid = $2)
                    OR (sender_user_uuid = $2 AND receiver_user_uuid = $1))
                  AND created_at < $3
                ORDER BY created_at DESC
                LIMIT $4
                "#,
            )
            .bind(user_uuid)
            .bind(other_user_uuid)
            .bind(at)
            .bind(take as i64)
            .fetch_all(&self.pool)
            .await
        } else {
            sqlx::query_as(
                r#"
                SELECT message_uuid, sender_user_uuid, receiver_user_uuid,
                       content, encrypted_for_receiver, encrypted_for_sender,
                       created_at, is_read
                FROM flora_core.user_messages
                WHERE (sender_user_uuid = $1 AND receiver_user_uuid = $2)
                   OR (sender_user_uuid = $2 AND receiver_user_uuid = $1)
                ORDER BY created_at DESC
                LIMIT $3
                "#,
            )
            .bind(user_uuid)
            .bind(other_user_uuid)
            .bind(take as i64)
            .fetch_all(&self.pool)
            .await
        }
        .map_err(|e| e.to_string())?;

        if rows.is_empty() {
            return Ok(Vec::new());
        }

        let msg_ids: Vec<Uuid> = rows.iter().map(|m| m.message_uuid).collect();
        let voice_by_msg = self.voice_uuids_by_message(&msg_ids).await?;
        let image_by_msg = self.image_uuids_by_message(&msg_ids).await?;
        let video_by_msg = self.video_uuids_by_message(&msg_ids).await?;

        Ok(rows
            .into_iter()
            .map(|m| {
                let is_from_me = m.sender_user_uuid == user_uuid;
                let encrypted_for_me = if is_from_me {
                    m.encrypted_for_sender
                } else {
                    m.encrypted_for_receiver
                };
                MessageRow {
                    message_uuid: m.message_uuid,
                    sender_user_uuid: m.sender_user_uuid,
                    encrypted_for_me,
                    content: m.content,
                    created_at: m.created_at,
                    is_read: m.is_read,
                    is_from_me,
                    voice_asset_uuids: voice_by_msg.get(&m.message_uuid).cloned().unwrap_or_default(),
                    image_asset_uuids: image_by_msg.get(&m.message_uuid).cloned().unwrap_or_default(),
                    video_asset_uuids: video_by_msg.get(&m.message_uuid).cloned().unwrap_or_default(),
                }
            })
            .collect())
    }

    async fn voice_uuids_by_message(
        &self,
        msg_ids: &[Uuid],
    ) -> Result<HashMap<Uuid, Vec<Uuid>>, String> {
        if msg_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows: Vec<AssetLinkRow> = sqlx::query_as(
            r#"
            SELECT message_uuid, voice_asset_uuid AS asset_uuid
            FROM flora_core.user_message_voice_assets
            WHERE message_uuid = ANY($1)
            "#,
        )
        .bind(msg_ids)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(group_assets(rows))
    }

    async fn image_uuids_by_message(
        &self,
        msg_ids: &[Uuid],
    ) -> Result<HashMap<Uuid, Vec<Uuid>>, String> {
        if msg_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows: Vec<AssetLinkRow> = sqlx::query_as(
            r#"
            SELECT message_uuid, image_asset_uuid AS asset_uuid
            FROM flora_core.user_message_image_assets
            WHERE message_uuid = ANY($1)
            "#,
        )
        .bind(msg_ids)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(group_assets(rows))
    }

    async fn video_uuids_by_message(
        &self,
        msg_ids: &[Uuid],
    ) -> Result<HashMap<Uuid, Vec<Uuid>>, String> {
        if msg_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows: Vec<AssetLinkRow> = sqlx::query_as(
            r#"
            SELECT message_uuid, video_asset_uuid AS asset_uuid
            FROM flora_core.user_message_video_assets
            WHERE message_uuid = ANY($1)
            "#,
        )
        .bind(msg_ids)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(group_assets(rows))
    }

    pub async fn send_message(
        &self,
        sender_uuid: Uuid,
        receiver_uuid: Uuid,
        encrypted_for_receiver: &str,
        encrypted_for_sender: &str,
        voice_asset_uuids: &[Uuid],
        image_asset_uuids: &[Uuid],
        video_asset_uuids: &[Uuid],
    ) -> Result<SendMessageRow, String> {
        let message_uuid = Uuid::now_v7();
        let created_at = Utc::now();

        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;

        sqlx::query(
            r#"
            INSERT INTO flora_core.user_messages
                (message_uuid, sender_user_uuid, receiver_user_uuid, content,
                 encrypted_for_receiver, encrypted_for_sender, created_at, is_read)
            VALUES ($1, $2, $3, NULL, $4, $5, $6, false)
            "#,
        )
        .bind(message_uuid)
        .bind(sender_uuid)
        .bind(receiver_uuid)
        .bind(encrypted_for_receiver)
        .bind(encrypted_for_sender)
        .bind(created_at)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        if !voice_asset_uuids.is_empty() {
            sqlx::query(
                r#"
                UPDATE flora_core.user_message_voice_assets
                SET message_uuid = $1
                WHERE voice_asset_uuid = ANY($2)
                "#,
            )
            .bind(message_uuid)
            .bind(voice_asset_uuids)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        }

        if !image_asset_uuids.is_empty() {
            sqlx::query(
                r#"
                UPDATE flora_core.user_message_image_assets
                SET message_uuid = $1
                WHERE image_asset_uuid = ANY($2)
                "#,
            )
            .bind(message_uuid)
            .bind(image_asset_uuids)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        }

        if !video_asset_uuids.is_empty() {
            sqlx::query(
                r#"
                UPDATE flora_core.user_message_video_assets
                SET message_uuid = $1
                WHERE video_asset_uuid = ANY($2)
                "#,
            )
            .bind(message_uuid)
            .bind(video_asset_uuids)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        }

        tx.commit().await.map_err(|e| e.to_string())?;

        Ok(SendMessageRow {
            message_uuid,
            created_at,
            encrypted_for_sender: encrypted_for_sender.to_string(),
        })
    }

    pub async fn validate_voice_assets(
        &self,
        sender_uuid: Uuid,
        receiver_uuid: Uuid,
        voice_uuids: &[Uuid],
    ) -> Result<(), String> {
        if voice_uuids.is_empty() {
            return Ok(());
        }
        let rows: Vec<VoiceAssetRow> = sqlx::query_as(
            r#"
            SELECT voice_asset_uuid, sender_user_uuid, receiver_user_uuid, message_uuid
            FROM flora_core.user_message_voice_assets
            WHERE voice_asset_uuid = ANY($1)
            "#,
        )
        .bind(voice_uuids)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        if rows.len() != voice_uuids.len() {
            return Err("Одно или несколько голосовых вложений не найдены.".into());
        }
        for a in &rows {
            if a.sender_user_uuid != sender_uuid
                || a.receiver_user_uuid != receiver_uuid
                || a.message_uuid.is_some()
            {
                return Err(
                    "Голосовое вложение не принадлежит этому черновику или уже отправлено.".into(),
                );
            }
        }
        Ok(())
    }

    pub async fn mark_read(
        &self,
        viewer_uuid: Uuid,
        other_user_uuid: Uuid,
    ) -> Result<(), String> {
        sqlx::query(
            r#"
            UPDATE flora_core.user_messages
            SET is_read = true
            WHERE sender_user_uuid = $1
              AND receiver_user_uuid = $2
              AND is_read = false
            "#,
        )
        .bind(other_user_uuid)
        .bind(viewer_uuid)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn delete_message(
        &self,
        viewer_uuid: Uuid,
        conversation_uuid: Uuid,
        message_uuid: Uuid,
    ) -> Result<DeleteMessageOutcome, String> {
        let row: Option<MessageOwnerRow> = sqlx::query_as(
            r#"
            SELECT message_uuid, sender_user_uuid, receiver_user_uuid
            FROM flora_core.user_messages
            WHERE message_uuid = $1
            "#,
        )
        .bind(message_uuid)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        let Some(msg) = row else {
            return Ok(DeleteMessageOutcome::NotFound);
        };

        let msg_conv =
            flora_shared::uuid_v5::dm_conversation_uuid(&msg.sender_user_uuid, &msg.receiver_user_uuid);
        if msg_conv != conversation_uuid {
            return Ok(DeleteMessageOutcome::NotFound);
        }
        if msg.sender_user_uuid != viewer_uuid {
            return Ok(DeleteMessageOutcome::Forbidden);
        }

        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        self.remove_message_assets_tx(&mut tx, message_uuid).await?;
        sqlx::query("DELETE FROM flora_core.user_messages WHERE message_uuid = $1")
            .bind(message_uuid)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(DeleteMessageOutcome::Success)
    }

    /// Legacy `DELETE /api/auth/messages/{messageUuid}` — без conversationUuid в пути.
    pub async fn delete_message_by_uuid(
        &self,
        viewer_uuid: Uuid,
        message_uuid: Uuid,
    ) -> Result<DeleteMessageOutcome, String> {
        let row: Option<MessageOwnerRow> = sqlx::query_as(
            r#"
            SELECT message_uuid, sender_user_uuid, receiver_user_uuid
            FROM flora_core.user_messages
            WHERE message_uuid = $1
            "#,
        )
        .bind(message_uuid)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        let Some(msg) = row else {
            return Ok(DeleteMessageOutcome::NotFound);
        };
        if msg.sender_user_uuid != viewer_uuid {
            return Ok(DeleteMessageOutcome::Forbidden);
        }

        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        self.remove_message_assets_tx(&mut tx, message_uuid).await?;
        sqlx::query("DELETE FROM flora_core.user_messages WHERE message_uuid = $1")
            .bind(message_uuid)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(DeleteMessageOutcome::Success)
    }

    pub async fn delete_conversation(
        &self,
        viewer_uuid: Uuid,
        other_user_uuid: Uuid,
    ) -> Result<DeleteConversationOutcome, String> {
        if other_user_uuid.is_nil() || other_user_uuid == viewer_uuid {
            return Ok(DeleteConversationOutcome::NotFound);
        }

        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        self.remove_peer_assets_tx(&mut tx, viewer_uuid, other_user_uuid)
            .await?;
        sqlx::query(
            r#"
            DELETE FROM flora_core.user_messages
            WHERE (sender_user_uuid = $1 AND receiver_user_uuid = $2)
               OR (sender_user_uuid = $2 AND receiver_user_uuid = $1)
            "#,
        )
        .bind(viewer_uuid)
        .bind(other_user_uuid)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(DeleteConversationOutcome::Success)
    }

    async fn remove_message_assets_tx(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        message_uuid: Uuid,
    ) -> Result<(), String> {
        sqlx::query("DELETE FROM flora_core.user_message_voice_assets WHERE message_uuid = $1")
            .bind(message_uuid)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("DELETE FROM flora_core.user_message_image_assets WHERE message_uuid = $1")
            .bind(message_uuid)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("DELETE FROM flora_core.user_message_video_assets WHERE message_uuid = $1")
            .bind(message_uuid)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    async fn remove_peer_assets_tx(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        user_a: Uuid,
        user_b: Uuid,
    ) -> Result<(), String> {
        sqlx::query(
            r#"
            DELETE FROM flora_core.user_message_voice_assets
            WHERE (sender_user_uuid = $1 AND receiver_user_uuid = $2)
               OR (sender_user_uuid = $2 AND receiver_user_uuid = $1)
            "#,
        )
        .bind(user_a)
        .bind(user_b)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        sqlx::query(
            r#"
            DELETE FROM flora_core.user_message_image_assets
            WHERE (sender_user_uuid = $1 AND receiver_user_uuid = $2)
               OR (sender_user_uuid = $2 AND receiver_user_uuid = $1)
            "#,
        )
        .bind(user_a)
        .bind(user_b)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        sqlx::query(
            r#"
            DELETE FROM flora_core.user_message_video_assets
            WHERE (sender_user_uuid = $1 AND receiver_user_uuid = $2)
               OR (sender_user_uuid = $2 AND receiver_user_uuid = $1)
            "#,
        )
        .bind(user_a)
        .bind(user_b)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[derive(sqlx::FromRow)]
struct MessageScanRow {
    message_uuid: Uuid,
    sender_user_uuid: Uuid,
    receiver_user_uuid: Uuid,
    content: Option<String>,
    encrypted_for_receiver: Option<String>,
    encrypted_for_sender: Option<String>,
    created_at: DateTime<Utc>,
    is_read: bool,
}

struct LastPeer {
    message_uuid: Uuid,
    content: Option<String>,
    enc_receiver: Option<String>,
    enc_sender: Option<String>,
    at: DateTime<Utc>,
    from_me: bool,
}

#[derive(sqlx::FromRow)]
struct AssetLinkRow {
    message_uuid: Option<Uuid>,
    asset_uuid: Uuid,
}

#[derive(sqlx::FromRow)]
struct VoiceAssetRow {
    #[allow(dead_code)]
    voice_asset_uuid: Uuid,
    sender_user_uuid: Uuid,
    receiver_user_uuid: Uuid,
    message_uuid: Option<Uuid>,
}

#[derive(sqlx::FromRow)]
struct MessageOwnerRow {
    #[allow(dead_code)]
    message_uuid: Uuid,
    sender_user_uuid: Uuid,
    receiver_user_uuid: Uuid,
}

fn group_assets(rows: Vec<AssetLinkRow>) -> HashMap<Uuid, Vec<Uuid>> {
    let mut out: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    for r in rows {
        if let Some(msg) = r.message_uuid {
            out.entry(msg).or_default().push(r.asset_uuid);
        }
    }
    out
}
