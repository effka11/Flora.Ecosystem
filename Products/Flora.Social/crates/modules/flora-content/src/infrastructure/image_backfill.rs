//! Resumable FRC-I (FRI-only) backfill for Content-owned tables.

use std::process::Command;

use frc_i_integration::{FRC_I_MIME, IngestOptions, coerce_to_fri};
use sqlx::PgPool;
use tracing::{info, warn};
use uuid::Uuid;

const BATCH: i64 = 24;

pub async fn run(pool: PgPool) {
    let mut converted = 0u64;
    converted += backfill_post_images(&pool).await;
    converted += backfill_community_avatars(&pool).await;
    converted += backfill_video_posters(&pool).await;
    info!(converted, "Content FRC-I image backfill finished");
}

async fn backfill_post_images(pool: &PgPool) -> u64 {
    let mut cursor = Uuid::nil();
    let mut converted = 0;
    loop {
        let rows: Vec<(Uuid, Vec<u8>)> = match sqlx::query_as(
            r#"
            SELECT uuid, data
            FROM flora_core.post_images
            WHERE uuid > $1 AND content_type <> $2
            ORDER BY uuid
            LIMIT $3
            "#,
        )
        .bind(cursor)
        .bind(FRC_I_MIME)
        .bind(BATCH)
        .fetch_all(pool)
        .await
        {
            Ok(rows) => rows,
            Err(error) => {
                warn!(%error, "post image FRC-I backfill query failed");
                return converted;
            }
        };
        if rows.is_empty() {
            return converted;
        }
        for (uuid, bytes) in rows {
            cursor = uuid;
            if let Some(encoded) = encode(&bytes, 2048, 85, "post image", uuid)
                && update_post_image(pool, uuid, &encoded).await
            {
                converted += 1;
            }
        }
    }
}

async fn backfill_community_avatars(pool: &PgPool) -> u64 {
    let mut cursor = Uuid::nil();
    let mut converted = 0;
    loop {
        let rows: Vec<(Uuid, Vec<u8>)> = match sqlx::query_as(
            r#"
            SELECT uuid, data
            FROM flora_core.community_avatars
            WHERE uuid > $1 AND content_type <> $2
            ORDER BY uuid
            LIMIT $3
            "#,
        )
        .bind(cursor)
        .bind(FRC_I_MIME)
        .bind(BATCH)
        .fetch_all(pool)
        .await
        {
            Ok(rows) => rows,
            Err(error) => {
                warn!(%error, "community avatar FRC-I backfill query failed");
                return converted;
            }
        };
        if rows.is_empty() {
            return converted;
        }
        for (uuid, bytes) in rows {
            cursor = uuid;
            if let Some(encoded) = encode(&bytes, 2048, 90, "community avatar", uuid)
                && update_community_avatar(pool, uuid, &encoded).await
            {
                converted += 1;
            }
        }
    }
}

async fn backfill_video_posters(pool: &PgPool) -> u64 {
    let mut cursor = Uuid::nil();
    let mut converted = 0;
    loop {
        let rows: Vec<(Uuid, Vec<u8>)> = match sqlx::query_as(
            r#"
            SELECT uuid, poster_data
            FROM flora_core.post_videos
            WHERE uuid > $1 AND poster_content_type <> $2 AND octet_length(poster_data) > 0
            ORDER BY uuid
            LIMIT $3
            "#,
        )
        .bind(cursor)
        .bind(FRC_I_MIME)
        .bind(BATCH)
        .fetch_all(pool)
        .await
        {
            Ok(rows) => rows,
            Err(error) => {
                warn!(%error, "video poster FRC-I backfill query failed");
                return converted;
            }
        };
        if rows.is_empty() {
            return converted;
        }
        for (uuid, bytes) in rows {
            cursor = uuid;
            if let Some(encoded) = encode(&bytes, 1280, 85, "video poster", uuid)
                && update_video_poster(pool, uuid, &encoded).await
            {
                converted += 1;
            }
        }
    }
}

fn encode(
    bytes: &[u8],
    max_dimension: u32,
    quality: u8,
    kind: &str,
    uuid: Uuid,
) -> Option<Vec<u8>> {
    let options = IngestOptions {
        max_dimension,
        max_pixels: 50_000_000,
        quality,
    };
    match coerce_to_fri(bytes, options) {
        Ok(encoded) => Some(encoded),
        Err(error) => match decode_via_ffmpeg_png(bytes) {
            Ok(png) => match coerce_to_fri(&png, options) {
                Ok(encoded) => Some(encoded),
                Err(reencode_error) => {
                    warn!(
                        %error,
                        %reencode_error,
                        %uuid,
                        kind,
                        "legacy media skipped during FRC-I backfill (ffmpeg png ok)"
                    );
                    None
                }
            },
            Err(ffmpeg_error) => {
                warn!(
                    %error,
                    ffmpeg_error,
                    %uuid,
                    kind,
                    "legacy media skipped during FRC-I backfill"
                );
                None
            }
        },
    }
}

/// AVIF (и прочие форматы вне `image` features) → PNG через ffmpeg, затем FRI.
fn decode_via_ffmpeg_png(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let dir = std::env::temp_dir().join(format!(
        "flora-fri-backfill-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let input = dir.join("in.bin");
    let output = dir.join("out.png");
    let cleanup = || {
        let _ = std::fs::remove_file(&input);
        let _ = std::fs::remove_file(&output);
        let _ = std::fs::remove_dir(&dir);
    };
    if let Err(error) = std::fs::write(&input, bytes) {
        cleanup();
        return Err(error.to_string());
    }
    let status = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(&input)
        .args(["-frames:v", "1"])
        .arg(&output)
        .status();
    let result = match status {
        Ok(code) if code.success() => std::fs::read(&output).map_err(|e| e.to_string()),
        Ok(code) => Err(format!("ffmpeg exit {code}")),
        Err(error) => Err(error.to_string()),
    };
    cleanup();
    result
}

async fn update_post_image(pool: &PgPool, uuid: Uuid, bytes: &[u8]) -> bool {
    sqlx::query(
        "UPDATE flora_core.post_images SET data = $1, content_type = $2 WHERE uuid = $3 AND content_type <> $2",
    )
    .bind(bytes)
    .bind(FRC_I_MIME)
    .bind(uuid)
    .execute(pool)
    .await
    .is_ok_and(|result| result.rows_affected() == 1)
}

async fn update_community_avatar(pool: &PgPool, uuid: Uuid, bytes: &[u8]) -> bool {
    sqlx::query(
        "UPDATE flora_core.community_avatars SET data = $1, content_type = $2 WHERE uuid = $3 AND content_type <> $2",
    )
    .bind(bytes)
    .bind(FRC_I_MIME)
    .bind(uuid)
    .execute(pool)
    .await
    .is_ok_and(|result| result.rows_affected() == 1)
}

async fn update_video_poster(pool: &PgPool, uuid: Uuid, bytes: &[u8]) -> bool {
    sqlx::query(
        "UPDATE flora_core.post_videos SET poster_data = $1, poster_content_type = $2 WHERE uuid = $3 AND poster_content_type <> $2",
    )
    .bind(bytes)
    .bind(FRC_I_MIME)
    .bind(uuid)
    .execute(pool)
    .await
    .is_ok_and(|result| result.rows_affected() == 1)
}
