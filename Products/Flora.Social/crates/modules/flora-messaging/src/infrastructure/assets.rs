//! Opaque E2E media blobs — `user_message_*_assets` (bytea, server never decrypts).

use chrono::Utc;
use sqlx::PgPool;
use uuid::Uuid;

pub struct ImageAssetRow {
    pub sender_user_uuid: Uuid,
    pub receiver_user_uuid: Uuid,
    pub message_uuid: Option<Uuid>,
    pub content_type: String,
    pub encrypted_bytes: Vec<u8>,
}

pub struct VoiceAssetRow {
    pub sender_user_uuid: Uuid,
    pub receiver_user_uuid: Uuid,
    pub message_uuid: Option<Uuid>,
    pub content_type: String,
    pub duration_ms: i32,
    pub encrypted_bytes: Vec<u8>,
}

pub struct VideoAssetRow {
    pub sender_user_uuid: Uuid,
    pub receiver_user_uuid: Uuid,
    pub message_uuid: Option<Uuid>,
    pub content_type: String,
    pub encrypted_bytes: Vec<u8>,
}

pub async fn insert_image_asset(
    pool: &PgPool,
    asset_uuid: Uuid,
    sender_uuid: Uuid,
    receiver_uuid: Uuid,
    content_type: &str,
    encrypted_bytes: &[u8],
) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO flora_core.user_message_image_assets
            (image_asset_uuid, sender_user_uuid, receiver_user_uuid, content_type, encrypted_bytes, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(asset_uuid)
    .bind(sender_uuid)
    .bind(receiver_uuid)
    .bind(content_type)
    .bind(encrypted_bytes)
    .bind(Utc::now())
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn insert_voice_asset(
    pool: &PgPool,
    asset_uuid: Uuid,
    sender_uuid: Uuid,
    receiver_uuid: Uuid,
    content_type: &str,
    duration_ms: i32,
    encrypted_bytes: &[u8],
) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO flora_core.user_message_voice_assets
            (voice_asset_uuid, sender_user_uuid, receiver_user_uuid, content_type,
             duration_ms, encrypted_bytes, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(asset_uuid)
    .bind(sender_uuid)
    .bind(receiver_uuid)
    .bind(content_type)
    .bind(duration_ms)
    .bind(encrypted_bytes)
    .bind(Utc::now())
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn insert_video_asset(
    pool: &PgPool,
    asset_uuid: Uuid,
    sender_uuid: Uuid,
    receiver_uuid: Uuid,
    content_type: &str,
    duration_ms: i32,
    encrypted_bytes: &[u8],
) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO flora_core.user_message_video_assets
            (video_asset_uuid, sender_user_uuid, receiver_user_uuid, content_type,
             duration_ms, encrypted_bytes, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(asset_uuid)
    .bind(sender_uuid)
    .bind(receiver_uuid)
    .bind(content_type)
    .bind(duration_ms)
    .bind(encrypted_bytes)
    .bind(Utc::now())
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn fetch_image_asset(
    pool: &PgPool,
    asset_uuid: Uuid,
) -> Result<Option<ImageAssetRow>, String> {
    sqlx::query_as::<_, ImageAssetDbRow>(
        r#"
        SELECT sender_user_uuid, receiver_user_uuid, message_uuid, content_type, encrypted_bytes
        FROM flora_core.user_message_image_assets
        WHERE image_asset_uuid = $1
        "#,
    )
    .bind(asset_uuid)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())
    .map(|row| row.map(Into::into))
}

pub async fn fetch_voice_asset(
    pool: &PgPool,
    asset_uuid: Uuid,
) -> Result<Option<VoiceAssetRow>, String> {
    sqlx::query_as::<_, VoiceAssetDbRow>(
        r#"
        SELECT sender_user_uuid, receiver_user_uuid, message_uuid, content_type,
               duration_ms, encrypted_bytes
        FROM flora_core.user_message_voice_assets
        WHERE voice_asset_uuid = $1
        "#,
    )
    .bind(asset_uuid)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())
    .map(|row| row.map(Into::into))
}

pub async fn fetch_video_asset(
    pool: &PgPool,
    asset_uuid: Uuid,
) -> Result<Option<VideoAssetRow>, String> {
    sqlx::query_as::<_, VideoAssetDbRow>(
        r#"
        SELECT sender_user_uuid, receiver_user_uuid, message_uuid, content_type, encrypted_bytes
        FROM flora_core.user_message_video_assets
        WHERE video_asset_uuid = $1
        "#,
    )
    .bind(asset_uuid)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())
    .map(|row| row.map(Into::into))
}

pub async fn is_message_participant(
    pool: &PgPool,
    message_uuid: Uuid,
    user_uuid: Uuid,
) -> Result<bool, String> {
    let found: Option<(i32,)> = sqlx::query_as(
        r#"
        SELECT 1
        FROM flora_core.user_messages
        WHERE message_uuid = $1
          AND (sender_user_uuid = $2 OR receiver_user_uuid = $2)
        LIMIT 1
        "#,
    )
    .bind(message_uuid)
    .bind(user_uuid)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(found.is_some())
}

#[derive(sqlx::FromRow)]
struct ImageAssetDbRow {
    sender_user_uuid: Uuid,
    receiver_user_uuid: Uuid,
    message_uuid: Option<Uuid>,
    content_type: String,
    encrypted_bytes: Vec<u8>,
}

#[derive(sqlx::FromRow)]
struct VoiceAssetDbRow {
    sender_user_uuid: Uuid,
    receiver_user_uuid: Uuid,
    message_uuid: Option<Uuid>,
    content_type: String,
    duration_ms: i32,
    encrypted_bytes: Vec<u8>,
}

#[derive(sqlx::FromRow)]
struct VideoAssetDbRow {
    sender_user_uuid: Uuid,
    receiver_user_uuid: Uuid,
    message_uuid: Option<Uuid>,
    content_type: String,
    encrypted_bytes: Vec<u8>,
}

impl From<ImageAssetDbRow> for ImageAssetRow {
    fn from(r: ImageAssetDbRow) -> Self {
        Self {
            sender_user_uuid: r.sender_user_uuid,
            receiver_user_uuid: r.receiver_user_uuid,
            message_uuid: r.message_uuid,
            content_type: r.content_type,
            encrypted_bytes: r.encrypted_bytes,
        }
    }
}

impl From<VoiceAssetDbRow> for VoiceAssetRow {
    fn from(r: VoiceAssetDbRow) -> Self {
        Self {
            sender_user_uuid: r.sender_user_uuid,
            receiver_user_uuid: r.receiver_user_uuid,
            message_uuid: r.message_uuid,
            content_type: r.content_type,
            duration_ms: r.duration_ms,
            encrypted_bytes: r.encrypted_bytes,
        }
    }
}

impl From<VideoAssetDbRow> for VideoAssetRow {
    fn from(r: VideoAssetDbRow) -> Self {
        Self {
            sender_user_uuid: r.sender_user_uuid,
            receiver_user_uuid: r.receiver_user_uuid,
            message_uuid: r.message_uuid,
            content_type: r.content_type,
            encrypted_bytes: r.encrypted_bytes,
        }
    }
}

#[allow(dead_code)]
pub fn normalize_content_type(raw: Option<&str>, fallback: Option<&str>) -> String {
    let pick = raw
        .or(fallback)
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .trim();
    if pick.is_empty() {
        "application/octet-stream".into()
    } else {
        pick.to_string()
    }
}
