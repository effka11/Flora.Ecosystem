//! Resumable FRC-I (FRI-only) backfill for Users-owned avatars.

use frc_i_integration::{FRC_I_MIME, IngestOptions, coerce_to_fri};
use sqlx::PgPool;
use tracing::{info, warn};
use uuid::Uuid;

const BATCH: i64 = 24;

pub async fn run(pool: PgPool) {
    let mut cursor = Uuid::nil();
    let mut converted = 0u64;
    loop {
        let rows: Vec<(Uuid, Vec<u8>)> = match sqlx::query_as(
            r#"
            SELECT uuid, data
            FROM flora_core.user_avatars
            WHERE uuid > $1 AND content_type <> $2
            ORDER BY uuid
            LIMIT $3
            "#,
        )
        .bind(cursor)
        .bind(FRC_I_MIME)
        .bind(BATCH)
        .fetch_all(&pool)
        .await
        {
            Ok(rows) => rows,
            Err(error) => {
                warn!(%error, "user avatar FRC-I backfill query failed");
                return;
            }
        };
        if rows.is_empty() {
            info!(converted, "Users FRC-I avatar backfill finished");
            return;
        }
        for (uuid, data) in rows {
            cursor = uuid;
            let encoded = match coerce_to_fri(
                &data,
                IngestOptions {
                    max_dimension: 2048,
                    max_pixels: 50_000_000,
                    quality: 85,
                },
            ) {
                Ok(encoded) => encoded,
                Err(error) => {
                    warn!(%error, %uuid, "legacy user avatar skipped during FRC-I backfill");
                    continue;
                }
            };
            match sqlx::query(
                "UPDATE flora_core.user_avatars SET data = $1, content_type = $2 WHERE uuid = $3 AND content_type <> $2",
            )
            .bind(&encoded)
            .bind(FRC_I_MIME)
            .bind(uuid)
            .execute(&pool)
            .await
            {
                Ok(result) if result.rows_affected() == 1 => converted += 1,
                Ok(_) => {}
                Err(error) => warn!(%error, %uuid, "user avatar FRC-I backfill update failed"),
            }
        }
    }
}
