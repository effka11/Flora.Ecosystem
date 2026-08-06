//! Репозиторий inbox — паритет `NotificationInboxService` list/unread (C#).

use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

pub struct InboxRepo {
    pool: PgPool,
}

#[derive(Debug, sqlx::FromRow)]
pub struct NotificationRow {
    pub notification_uuid: Uuid,

    #[sqlx(rename = "type")]
    pub notification_type: String,

    pub category: String,

    pub text: String,

    pub created_at: DateTime<Utc>,

    pub is_read: bool,

    pub post_uuid: Option<Uuid>,

    pub comment_uuid: Option<Uuid>,
}

/// Aggregated social inbox row (`group_key` / `actors_json`).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SocialGroupRow {
    pub notification_uuid: Uuid,

    #[sqlx(rename = "type")]
    pub notification_type: String,

    pub category: String,

    pub text: String,

    pub actor_user_uuid: Option<Uuid>,

    pub post_uuid: Option<Uuid>,

    pub created_at: DateTime<Utc>,

    pub is_read: bool,

    pub group_key: String,

    pub actor_count: i32,

    pub actors_json: serde_json::Value,
}

impl InboxRepo {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn begin(&self) -> Result<Transaction<'_, Postgres>, String> {
        self.pool.begin().await.map_err(|e| e.to_string())
    }

    /// Lock aggregated social row for apply/retract (if present).
    pub async fn find_by_group_for_update(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        recipient_user_uuid: Uuid,
        group_key: &str,
    ) -> Result<Option<SocialGroupRow>, String> {
        sqlx::query_as::<_, SocialGroupRow>(
            r#"
            SELECT notification_uuid, type, category, text, actor_user_uuid, post_uuid,
                   created_at, is_read, group_key, actor_count, actors_json
            FROM flora_core.user_notifications
            WHERE recipient_user_uuid = $1 AND group_key = $2
            FOR UPDATE
            "#,
        )
        .bind(recipient_user_uuid)
        .bind(group_key)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())
    }

    /// Insert or update aggregated social membership/text.
    #[allow(clippy::too_many_arguments)]
    pub async fn upsert_group(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        notification_uuid: Uuid,
        recipient_user_uuid: Uuid,
        actor_user_uuid: Uuid,
        notification_type: &str,
        category: &str,
        text: &str,
        post_uuid: Option<Uuid>,
        group_key: &str,
        actor_count: i32,
        actors_json: &serde_json::Value,
        created_at: DateTime<Utc>,
        existing: bool,
    ) -> Result<(), String> {
        if existing {
            sqlx::query(
                r#"
                UPDATE flora_core.user_notifications
                SET actor_user_uuid = $2,
                    text = $3,
                    actor_count = $4,
                    actors_json = $5,
                    created_at = $6,
                    is_read = false
                WHERE notification_uuid = $1
                "#,
            )
            .bind(notification_uuid)
            .bind(actor_user_uuid)
            .bind(text)
            .bind(actor_count)
            .bind(actors_json)
            .bind(created_at)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        } else {
            sqlx::query(
                r#"
                INSERT INTO flora_core.user_notifications
                    (notification_uuid, recipient_user_uuid, actor_user_uuid, type, category, text,
                     post_uuid, comment_uuid, target_platform, is_read, created_at,
                     group_key, actor_count, actors_json)
                VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, false, $8, $9, $10, $11)
                "#,
            )
            .bind(notification_uuid)
            .bind(recipient_user_uuid)
            .bind(actor_user_uuid)
            .bind(notification_type)
            .bind(category)
            .bind(text)
            .bind(post_uuid)
            .bind(created_at)
            .bind(group_key)
            .bind(actor_count)
            .bind(actors_json)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Partial retract: update membership/text without bumping `created_at`.
    #[allow(clippy::too_many_arguments)]
    pub async fn update_group_membership(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        notification_uuid: Uuid,
        actor_user_uuid: Option<Uuid>,
        text: &str,
        actor_count: i32,
        actors_json: &serde_json::Value,
    ) -> Result<(), String> {
        sqlx::query(
            r#"
            UPDATE flora_core.user_notifications
            SET actor_user_uuid = $2,
                text = $3,
                actor_count = $4,
                actors_json = $5
            WHERE notification_uuid = $1
            "#,
        )
        .bind(notification_uuid)
        .bind(actor_user_uuid)
        .bind(text)
        .bind(actor_count)
        .bind(actors_json)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn delete_by_uuid(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        notification_uuid: Uuid,
    ) -> Result<(), String> {
        sqlx::query(
            r#"
            DELETE FROM flora_core.user_notifications
            WHERE notification_uuid = $1
            "#,
        )
        .bind(notification_uuid)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn get_push_state(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        recipient_user_uuid: Uuid,
        group_key: &str,
    ) -> Result<Option<DateTime<Utc>>, String> {
        sqlx::query_scalar::<_, DateTime<Utc>>(
            r#"
            SELECT last_push_at
            FROM flora_core.social_notification_push_state
            WHERE recipient_user_uuid = $1 AND group_key = $2
            "#,
        )
        .bind(recipient_user_uuid)
        .bind(group_key)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())
    }

    /// Claim audible FCM budget under the same tx as group upsert (before commit).
    /// Concurrent apply waits on `FOR UPDATE` group row, then sees this claim → SseOnly.
    pub async fn set_push_state(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        recipient_user_uuid: Uuid,
        group_key: &str,
        last_push_at: DateTime<Utc>,
    ) -> Result<(), String> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.social_notification_push_state
                (recipient_user_uuid, group_key, last_push_at)
            VALUES ($1, $2, $3)
            ON CONFLICT (recipient_user_uuid, group_key)
            DO UPDATE SET last_push_at = EXCLUDED.last_push_at
            "#,
        )
        .bind(recipient_user_uuid)
        .bind(group_key)
        .bind(last_push_at)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Insert social/inbox row — паритет `NotificationInboxService.DispatchAsync` WRITE.
    #[allow(clippy::too_many_arguments)]
    pub async fn insert(
        &self,
        notification_uuid: Uuid,
        recipient_user_uuid: Uuid,
        actor_user_uuid: Option<Uuid>,
        notification_type: &str,
        category: &str,
        text: &str,
        post_uuid: Option<Uuid>,
        comment_uuid: Option<Uuid>,
        created_at: DateTime<Utc>,
    ) -> Result<(), String> {
        self.insert_with_target(
            notification_uuid,
            recipient_user_uuid,
            actor_user_uuid,
            notification_type,
            category,
            text,
            post_uuid,
            comment_uuid,
            None,
            created_at,
        )
        .await
    }

    /// Insert with optional `target_platform` — broadcast rows set audience platform.
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_with_target(
        &self,
        notification_uuid: Uuid,
        recipient_user_uuid: Uuid,
        actor_user_uuid: Option<Uuid>,
        notification_type: &str,
        category: &str,
        text: &str,
        post_uuid: Option<Uuid>,
        comment_uuid: Option<Uuid>,
        target_platform: Option<&str>,
        created_at: DateTime<Utc>,
    ) -> Result<(), String> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.user_notifications
                (notification_uuid, recipient_user_uuid, actor_user_uuid, type, category, text,
                 post_uuid, comment_uuid, target_platform, is_read, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10)
            "#,
        )
        .bind(notification_uuid)
        .bind(recipient_user_uuid)
        .bind(actor_user_uuid)
        .bind(notification_type)
        .bind(category)
        .bind(text)
        .bind(post_uuid)
        .bind(comment_uuid)
        .bind(target_platform)
        .bind(created_at)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn list(
        &self,

        recipient: Uuid,

        category: Option<&str>,

        search: Option<&str>,

        skip: i32,

        take: i32,

        client_platform: Option<&str>,
    ) -> Result<Vec<NotificationRow>, String> {
        let rows = sqlx::query_as::<_, NotificationRow>(

            r#"

            SELECT notification_uuid, type, category, text, created_at, is_read, post_uuid, comment_uuid

            FROM flora_core.user_notifications

            WHERE recipient_user_uuid = $1

              AND CASE

                    WHEN $2::text IS NULL THEN target_platform IS NULL

                    ELSE target_platform IS NULL OR target_platform = $2

                  END

              AND ($3::text IS NULL OR category = $3)

              AND ($4::text IS NULL OR text ILIKE $4)

            ORDER BY created_at DESC

            OFFSET $5 LIMIT $6

            "#,

        )

        .bind(recipient)

        .bind(client_platform)

        .bind(category)

        .bind(search)

        .bind(i64::from(skip))

        .bind(i64::from(take))

        .fetch_all(&self.pool)

        .await

        .map_err(|e| e.to_string())?;

        Ok(rows)
    }

    pub async fn unread_count(
        &self,

        recipient: Uuid,

        client_platform: Option<&str>,
    ) -> Result<i64, String> {
        sqlx::query_scalar(
            r#"

            SELECT COUNT(*)::bigint

            FROM flora_core.user_notifications

            WHERE recipient_user_uuid = $1

              AND is_read = false

              AND CASE

                    WHEN $2::text IS NULL THEN target_platform IS NULL

                    ELSE target_platform IS NULL OR target_platform = $2

                  END

            "#,
        )
        .bind(recipient)
        .bind(client_platform)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }

    /// Паритет `MarkReadAsync`: false = not found, true = found (already read or updated).
    pub async fn mark_read(
        &self,

        recipient: Uuid,

        notification_uuid: Uuid,
    ) -> Result<bool, String> {
        let updated = sqlx::query_scalar::<_, i32>(
            r#"

            UPDATE flora_core.user_notifications

            SET is_read = true

            WHERE notification_uuid = $1

              AND recipient_user_uuid = $2

              AND is_read = false

            RETURNING 1

            "#,
        )
        .bind(notification_uuid)
        .bind(recipient)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        if updated.is_some() {
            return Ok(true);
        }

        let exists = sqlx::query_scalar::<_, i32>(
            r#"

            SELECT 1

            FROM flora_core.user_notifications

            WHERE notification_uuid = $1 AND recipient_user_uuid = $2

            "#,
        )
        .bind(notification_uuid)
        .bind(recipient)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        Ok(exists.is_some())
    }

    /// Паритет `MarkAllReadAsync` — число обновлённых строк.
    pub async fn mark_all_read(
        &self,

        recipient: Uuid,

        client_platform: Option<&str>,
    ) -> Result<i64, String> {
        let result = sqlx::query(
            r#"

            UPDATE flora_core.user_notifications

            SET is_read = true

            WHERE recipient_user_uuid = $1

              AND is_read = false

              AND CASE

                    WHEN $2::text IS NULL THEN target_platform IS NULL

                    ELSE target_platform IS NULL OR target_platform = $2

                  END

            "#,
        )
        .bind(recipient)
        .bind(client_platform)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        Ok(i64::try_from(result.rows_affected()).unwrap_or(i64::MAX))
    }

    /// Паритет `DeleteAsync` — число удалённых строк.
    pub async fn delete(
        &self,

        recipient: Uuid,

        notification_uuids: &[Uuid],
    ) -> Result<i64, String> {
        if notification_uuids.is_empty() {
            return Ok(0);
        }

        let result = sqlx::query(
            r#"

            DELETE FROM flora_core.user_notifications

            WHERE recipient_user_uuid = $1 AND notification_uuid = ANY($2)

            "#,
        )
        .bind(recipient)
        .bind(notification_uuids)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        Ok(i64::try_from(result.rows_affected()).unwrap_or(i64::MAX))
    }

    /// Паритет `DeleteAllAsync` — число удалённых строк.
    pub async fn delete_all(
        &self,

        recipient: Uuid,

        client_platform: Option<&str>,
    ) -> Result<i64, String> {
        let result = sqlx::query(
            r#"

            DELETE FROM flora_core.user_notifications

            WHERE recipient_user_uuid = $1

              AND CASE

                    WHEN $2::text IS NULL THEN target_platform IS NULL

                    ELSE target_platform IS NULL OR target_platform = $2

                  END

            "#,
        )
        .bind(recipient)
        .bind(client_platform)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        Ok(i64::try_from(result.rows_affected()).unwrap_or(i64::MAX))
    }
}
