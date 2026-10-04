//! sqlx-репозиторий verification_challenges (схема без изменений).

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ChallengeRow {
    pub token: Uuid,
    pub kind: i32,
    pub target: String,
    pub subject_user_uuid: Option<Uuid>,
    pub code_hash: String,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub attempts: i32,
}

pub struct VerificationRepo {
    pool: PgPool,
}

impl VerificationRepo {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn find_by_token(&self, token: Uuid) -> Result<Option<ChallengeRow>, sqlx::Error> {
        sqlx::query_as::<_, ChallengeRow>(
            r#"
            SELECT token, kind, target, subject_user_uuid, code_hash,
                   expires_at, created_at, updated_at, attempts
            FROM flora_core.verification_challenges
            WHERE token = $1
            "#,
        )
        .bind(token)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn add(&self, row: &ChallengeRow) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.verification_challenges (
                token, kind, target, subject_user_uuid, code_hash,
                expires_at, created_at, updated_at, attempts
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            "#,
        )
        .bind(row.token)
        .bind(row.kind)
        .bind(&row.target)
        .bind(row.subject_user_uuid)
        .bind(&row.code_hash)
        .bind(row.expires_at)
        .bind(row.created_at)
        .bind(row.updated_at)
        .bind(row.attempts)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn increment_attempts(
        &self,
        token: Uuid,
        updated_at: DateTime<Utc>,
    ) -> Result<Option<i32>, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            UPDATE flora_core.verification_challenges
            SET attempts = attempts + 1, updated_at = $2
            WHERE token = $1
            RETURNING attempts
            "#,
        )
        .bind(token)
        .bind(updated_at)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn remove(&self, token: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM flora_core.verification_challenges WHERE token = $1")
            .bind(token)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Одноразово потребляет ещё действующий challenge. Условие по хешу
    /// делает параллельную двойную валидацию безопасной: победит один запрос.
    pub async fn consume_if_matches(
        &self,
        token: Uuid,
        code_hash: &str,
        utc_now: DateTime<Utc>,
        max_attempts: i32,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            r#"
            DELETE FROM flora_core.verification_challenges
            WHERE token = $1
              AND code_hash = $2
              AND expires_at > $3
              AND attempts < $4
            "#,
        )
        .bind(token)
        .bind(code_hash)
        .bind(utc_now)
        .bind(max_attempts)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn remove_expired(&self, utc_now: DateTime<Utc>) -> Result<u64, sqlx::Error> {
        let result =
            sqlx::query("DELETE FROM flora_core.verification_challenges WHERE expires_at <= $1")
                .bind(utc_now)
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected())
    }
}
