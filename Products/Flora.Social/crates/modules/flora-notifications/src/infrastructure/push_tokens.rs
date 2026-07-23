//! Push token upsert/delete — паритет `PushTokenService` (C#).

use chrono::Utc;
use flora_shared::flora_uuid;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PushTokenRecord {
    #[sqlx(rename = "Token")]
    pub token: String,
    #[sqlx(rename = "Platform")]
    pub platform: String,
    #[sqlx(rename = "Provider")]
    pub provider: Option<String>,
    #[sqlx(rename = "InstallationUuid")]
    pub installation_uuid: Option<Uuid>,
    #[sqlx(rename = "SecurePreviewVersion")]
    pub secure_preview_version: Option<i32>,
    #[sqlx(rename = "PreviewKeyId")]
    pub preview_key_id: Option<Uuid>,
    #[sqlx(rename = "PreviewPublicKey")]
    pub preview_public_key: Option<String>,
}

pub struct PushTokenRepo {
    pool: PgPool,
}

impl PushTokenRepo {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Upsert by token (unique). Columns are PascalCase (EF migration as-written).
    #[allow(clippy::too_many_arguments)]
    pub async fn register(
        &self,
        user_uuid: Uuid,
        token: &str,
        platform: &str,
        provider: &str,
        installation_uuid: Option<Uuid>,
        secure_preview_version: Option<i32>,
        preview_key_id: Option<Uuid>,
        preview_public_key: Option<&str>,
    ) -> Result<(), String> {
        let now = Utc::now();
        let updated = sqlx::query(
            r#"
            UPDATE flora_core.user_push_tokens
            SET "UserUuid" = $1, "Platform" = $2, "Provider" = $3,
                "InstallationUuid" = $4, "SecurePreviewVersion" = $5,
                "PreviewKeyId" = $6, "PreviewPublicKey" = $7, "UpdatedAt" = $8
            WHERE "Token" = $9
            "#,
        )
        .bind(user_uuid)
        .bind(platform)
        .bind(provider)
        .bind(installation_uuid)
        .bind(secure_preview_version)
        .bind(preview_key_id)
        .bind(preview_public_key)
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
                ("PushTokenUuid", "UserUuid", "Token", "Platform", "Provider",
                 "InstallationUuid", "SecurePreviewVersion", "PreviewKeyId",
                 "PreviewPublicKey", "UpdatedAt")
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            "#,
        )
        .bind(push_token_uuid)
        .bind(user_uuid)
        .bind(token)
        .bind(platform)
        .bind(provider)
        .bind(installation_uuid)
        .bind(secure_preview_version)
        .bind(preview_key_id)
        .bind(preview_public_key)
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
              AND "UpdatedAt" >= now() - interval '90 days'
            ORDER BY "UpdatedAt" DESC
            "#,
        )
        .bind(user_uuid)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub async fn records_for_user(&self, user_uuid: Uuid) -> Result<Vec<PushTokenRecord>, String> {
        sqlx::query_as::<_, PushTokenRecord>(
            r#"
            SELECT "Token", "Platform", "Provider", "InstallationUuid",
                   "SecurePreviewVersion", "PreviewKeyId", "PreviewPublicKey"
            FROM flora_core.user_push_tokens
            WHERE "UserUuid" = $1
            ORDER BY "UpdatedAt" DESC
            "#,
        )
        .bind(user_uuid)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }

    /// Android (or ios) tokens only — sideload `app_update` must not hit iOS tokens.
    pub async fn tokens_for_user_platform(
        &self,
        user_uuid: Uuid,
        platform: &str,
    ) -> Result<Vec<String>, String> {
        let plat = normalize_platform(platform);
        let rows = sqlx::query_scalar::<_, String>(
            r#"
            SELECT "Token"
            FROM flora_core.user_push_tokens
            WHERE "UserUuid" = $1 AND "Platform" = $2
            ORDER BY "UpdatedAt" DESC
            "#,
        )
        .bind(user_uuid)
        .bind(plat)
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
