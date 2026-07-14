//! sqlx-репозиторий Auth (`user_sessions`).

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

const STATUS_ACTIVE: i32 = 0;
/// `UserSessionStatus.RevokedUser` — паритет с C#.
const STATUS_REVOKED_USER: i32 = 4;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SessionRow {
    pub session_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub last_activity: DateTime<Utc>,
    pub ip_address: String,
    pub city: Option<String>,
    pub country_code: Option<String>,
    pub jwt_id: String,
}

pub struct AuthRepo {
    pool: PgPool,
}

impl AuthRepo {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn list_active_sessions(
        &self,
        user_uuid: Uuid,
        now: DateTime<Utc>,
    ) -> Result<Vec<SessionRow>, sqlx::Error> {
        sqlx::query_as::<_, SessionRow>(
            r#"
            SELECT session_id, created_at, last_activity, ip_address, city, country_code, jwt_id
            FROM flora_core.user_sessions
            WHERE user_uuid = $1
              AND status = $2
              AND expires_at > $3
            ORDER BY last_activity DESC
            "#,
        )
        .bind(user_uuid)
        .bind(STATUS_ACTIVE)
        .bind(now)
        .fetch_all(&self.pool)
        .await
    }

    /// Завершить все активные сессии пользователя, кроме текущей (по `jwt_id`).
    /// Если `current_jti` пуст — отзываются все активные (как в C#).
    pub async fn revoke_other_sessions(
        &self,
        user_uuid: Uuid,
        current_jti: &str,
        now: DateTime<Utc>,
    ) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            r#"
            UPDATE flora_core.user_sessions
            SET status = $1
            WHERE user_uuid = $2
              AND status = $3
              AND expires_at > $4
              AND ($5 = '' OR jwt_id <> $5)
            "#,
        )
        .bind(STATUS_REVOKED_USER)
        .bind(user_uuid)
        .bind(STATUS_ACTIVE)
        .bind(now)
        .bind(current_jti)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    /// Отозвать сессию по `jwt_id` (logout). Как в C#: без фильтра по status.
    pub async fn revoke_by_jwt_id(&self, jwt_id: &str) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            r#"
            UPDATE flora_core.user_sessions
            SET status = $1
            WHERE jwt_id = $2
            "#,
        )
        .bind(STATUS_REVOKED_USER)
        .bind(jwt_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }
}
