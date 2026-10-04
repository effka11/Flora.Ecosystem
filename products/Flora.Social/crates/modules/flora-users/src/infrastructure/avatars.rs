//! `flora_core.user_avatars` + `user_profiles.avatar_uuid` (Users-owned).

use chrono::Utc;
use flora_users_contracts::{BoxFuture, UserAvatarMedia, UserAvatarMediaBlob};
use sqlx::PgPool;
use uuid::Uuid;

pub async fn insert_user_avatar(
    pool: &PgPool,
    avatar_uuid: Uuid,
    user_uuid: Uuid,
    content_type: &str,
    data: &[u8],
) -> Result<(), sqlx::Error> {
    let now = Utc::now();
    sqlx::query(
        r#"
        INSERT INTO flora_core.user_avatars (uuid, user_uuid, content_type, data, created_at)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(avatar_uuid)
    .bind(user_uuid)
    .bind(content_type)
    .bind(data)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn set_profile_avatar_uuid(
    pool: &PgPool,
    user_uuid: Uuid,
    avatar_uuid: Uuid,
) -> Result<(), sqlx::Error> {
    let now = Utc::now();
    let updated = sqlx::query(
        r#"
        UPDATE flora_core.user_profiles
        SET avatar_uuid = $1, updated_at = $2
        WHERE user_uuid = $3
        "#,
    )
    .bind(avatar_uuid)
    .bind(now)
    .bind(user_uuid)
    .execute(pool)
    .await?;
    if updated.rows_affected() == 0 {
        sqlx::query(
            r#"
            INSERT INTO flora_core.user_profiles (user_uuid, display_name, avatar_uuid, created_at, updated_at)
            VALUES ($1, '', $2, $3, $3)
            "#,
        )
        .bind(user_uuid)
        .bind(avatar_uuid)
        .bind(now)
        .execute(pool)
        .await?;
    }
    Ok(())
}

pub async fn clear_profile_avatar_uuid(pool: &PgPool, user_uuid: Uuid) -> Result<(), String> {
    let now = Utc::now();
    sqlx::query(
        r#"
        UPDATE flora_core.user_profiles
        SET avatar_uuid = NULL, updated_at = $1
        WHERE user_uuid = $2 AND avatar_uuid IS NOT NULL
        "#,
    )
    .bind(now)
    .bind(user_uuid)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub struct SqlUserAvatarMedia {
    pool: PgPool,
}

impl SqlUserAvatarMedia {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

impl UserAvatarMedia for SqlUserAvatarMedia {
    fn by_uuid(
        &self,
        avatar_uuid: Uuid,
    ) -> BoxFuture<'_, Result<Option<UserAvatarMediaBlob>, String>> {
        Box::pin(async move {
            let row: Option<(Vec<u8>, String)> = sqlx::query_as(
                r#"
                SELECT data, content_type
                FROM flora_core.user_avatars
                WHERE uuid = $1
                "#,
            )
            .bind(avatar_uuid)
            .fetch_optional(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
            Ok(row
                .filter(|(data, _)| !data.is_empty())
                .map(|(data, content_type)| UserAvatarMediaBlob { data, content_type }))
        })
    }
}
