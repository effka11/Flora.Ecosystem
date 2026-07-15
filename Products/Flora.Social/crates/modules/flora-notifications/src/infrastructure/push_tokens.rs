//! Push token upsert/delete — паритет `PushTokenService` (C#).

use chrono::Utc;
use flora_shared::flora_uuid;
use sqlx::PgPool;
use uuid::Uuid;

pub struct PushTokenRepo {
    pool: PgPool,
}

impl PushTokenRepo {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Upsert by token (unique). Columns are PascalCase (EF migration as-written).
    pub async fn register(
        &self,
        user_uuid: Uuid,
        token: &str,
        platform: &str,
    ) -> Result<(), String> {
        let now = Utc::now();
        let updated = sqlx::query(
            r#"
            UPDATE flora_core.user_push_tokens
            SET "UserUuid" = $1, "Platform" = $2, "UpdatedAt" = $3
            WHERE "Token" = $4
            "#,
        )
        .bind(user_uuid)
        .bind(platform)
        .bind(now)
        .bind(token)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        if updated.rows_affected() > 0 {
            return Ok(());
        }

        let push_token_uuid = flora_uuid::new_uuid();
        sqlx::query(
            r#"
            INSERT INTO flora_core.user_push_tokens
                ("PushTokenUuid", "UserUuid", "Token", "Platform", "UpdatedAt")
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(push_token_uuid)
        .bind(user_uuid)
        .bind(token)
        .bind(platform)
        .bind(now)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub async fn unregister(&self, user_uuid: Uuid, token: &str) -> Result<(), String> {
        sqlx::query(
            r#"
            DELETE FROM flora_core.user_push_tokens
            WHERE "UserUuid" = $1 AND "Token" = $2
            "#,
        )
        .bind(user_uuid)
        .bind(token)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Tokens newest-first — паритет `GetTokensForUserAsync`.
    pub async fn tokens_for_user(&self, user_uuid: Uuid) -> Result<Vec<String>, String> {
        let rows = sqlx::query_scalar::<_, String>(
            r#"
            SELECT "Token"
            FROM flora_core.user_push_tokens
            WHERE "UserUuid" = $1
            ORDER BY "UpdatedAt" DESC
            "#,
        )
        .bind(user_uuid)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    /// Паритет `PushTokenService.ListUserUuidsByPlatformAsync`.
    pub async fn list_user_uuids_by_platform(&self, platform: &str) -> Result<Vec<Uuid>, String> {
        let plat = normalize_platform(platform);
        sqlx::query_scalar(
            r#"
            SELECT DISTINCT "UserUuid"
            FROM flora_core.user_push_tokens
            WHERE "Platform" = $1
            "#,
        )
        .bind(plat)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }
}

fn normalize_platform(platform: &str) -> String {
    let p = platform.trim().to_ascii_lowercase();
    if p == "ios" {
        "ios".into()
    } else {
        "android".into()
    }
}
