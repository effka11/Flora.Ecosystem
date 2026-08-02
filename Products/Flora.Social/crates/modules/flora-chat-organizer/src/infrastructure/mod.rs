//! Persistence: opaque organizer blob.

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct StoredBlob {
    pub revision: i64,
    pub wire: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone)]
pub struct OrganizerRepo {
    pool: PgPool,
}

impl OrganizerRepo {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn get(&self, owner: Uuid) -> Result<Option<StoredBlob>, sqlx::Error> {
        let row = sqlx::query_as::<_, (i64, String, DateTime<Utc>)>(
            r#"
            SELECT revision, wire, updated_at
            FROM flora_core.user_chat_organizer_blobs
            WHERE owner_user_uuid = $1
            "#,
        )
        .bind(owner)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|(revision, wire, updated_at)| StoredBlob {
            revision,
            wire,
            updated_at,
        }))
    }

    /// Insert or update only when `revision == expected_previous + 1`
    /// (`expected_previous == 0` means first write with revision 1).
    /// Returns whether a row was written.
    pub async fn put_if_next_revision(
        &self,
        owner: Uuid,
        revision: i64,
        wire: &str,
        updated_at: DateTime<Utc>,
    ) -> Result<bool, sqlx::Error> {
        if revision == 1 {
            let result = sqlx::query(
                r#"
                INSERT INTO flora_core.user_chat_organizer_blobs
                    (owner_user_uuid, revision, wire, updated_at)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (owner_user_uuid) DO NOTHING
                "#,
            )
            .bind(owner)
            .bind(revision)
            .bind(wire)
            .bind(updated_at)
            .execute(&self.pool)
            .await?;
            return Ok(result.rows_affected() == 1);
        }

        let result = sqlx::query(
            r#"
            UPDATE flora_core.user_chat_organizer_blobs
            SET revision = $2, wire = $3, updated_at = $4
            WHERE owner_user_uuid = $1 AND revision = $2 - 1
            "#,
        )
        .bind(owner)
        .bind(revision)
        .bind(wire)
        .bind(updated_at)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }
}
