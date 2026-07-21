//! D2D recovery transport (recover-key) — opaque-хранилище DeviceToDeviceRecoveryEnvelope.
//!
//! Сервер хранит canonical JSON конверта (после структурной проверки и проверки
//! подписи в application-слое) до истечения TTL; ciphertext открывает только
//! target-устройство. Replay-защита: `recoveryRequestId` + hash тела.

use chrono::{DateTime, Duration, Utc};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use super::e2e_epochs::E2eEpochRepoError;

/// TTL конверта — как у unlock-challenge (пользователь переносит material
/// между двумя устройствами в рамках одной короткой сессии).
pub const RECOVERY_ENVELOPE_TTL_MINUTES: i64 = 15;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct StoredRecoveryEnvelopeRow {
    pub source_device_uuid: Uuid,
    pub recovery_request_id: Uuid,
    pub transferred_key_epoch_ids: Vec<Uuid>,
    pub envelope_canonical_json: String,
    pub request_body_hash: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

/// Server-attested запись устройства для проверок authority/подписи.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DeviceBindingRow {
    pub status: String,
    pub signing_public_key_base64url: String,
}

pub async fn fetch_device_binding(
    pool: &PgPool,
    user_uuid: Uuid,
    key_epoch_id: Uuid,
    device_uuid: Uuid,
) -> Result<Option<DeviceBindingRow>, E2eEpochRepoError> {
    sqlx::query_as(
        r#"
        SELECT status, signing_public_key_base64url
        FROM flora_core.user_device_keys
        WHERE device_uuid = $1 AND user_uuid = $2 AND key_epoch_id = $3
        "#,
    )
    .bind(device_uuid)
    .bind(user_uuid)
    .bind(key_epoch_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))
}

/// Сохраняет конверт для target-устройства (upsert в scope `(user, epoch, device)`).
///
/// Правила замещения: живой конверт с тем же `recoveryRequestId` и тем же телом —
/// идемпотентный replay (возвращается прежний `expires_at`); тот же request id
/// с другим телом — Conflict; новый request id — замещает предыдущий (новая
/// попытка передачи от аутентифицированного source-устройства).
#[allow(clippy::too_many_arguments)]
pub async fn store_recovery_envelope(
    pool: &PgPool,
    user_uuid: Uuid,
    key_epoch_id: Uuid,
    target_device_uuid: Uuid,
    source_device_uuid: Uuid,
    recovery_request_id: Uuid,
    transferred_key_epoch_ids: &[Uuid],
    envelope_canonical_json: &str,
) -> Result<DateTime<Utc>, E2eEpochRepoError> {
    let body_hash = compute_body_hash(envelope_canonical_json);
    let now = Utc::now();

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    // SELECT ... FOR UPDATE не сериализует конкурентные первые INSERT, когда строки
    // ещё нет. Transaction-scoped advisory lock закрывает этот race и сохраняет
    // replay-инвариант «тот же request id + другое тело → Conflict».
    let lock_scope = format!("{user_uuid}:{key_epoch_id}:{target_device_uuid}");
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(lock_scope)
        .execute(&mut *tx)
        .await
        .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    let existing: Option<StoredRecoveryEnvelopeRow> = sqlx::query_as(
        r#"
        SELECT source_device_uuid, recovery_request_id, transferred_key_epoch_ids,
               envelope_canonical_json, request_body_hash, created_at, expires_at
        FROM flora_core.user_device_recovery_envelopes
        WHERE user_uuid = $1 AND key_epoch_id = $2 AND target_device_uuid = $3
        FOR UPDATE
        "#,
    )
    .bind(user_uuid)
    .bind(key_epoch_id)
    .bind(target_device_uuid)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    if let Some(existing) = existing
        && existing.expires_at > now
        && existing.recovery_request_id == recovery_request_id
    {
        if existing.request_body_hash.eq_ignore_ascii_case(&body_hash) {
            tx.commit()
                .await
                .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;
            return Ok(existing.expires_at);
        }
        return Err(E2eEpochRepoError::Conflict(
            "recoveryRequestId уже использован с другим конвертом.".into(),
        ));
    }

    let expires_at = now + Duration::minutes(RECOVERY_ENVELOPE_TTL_MINUTES);
    sqlx::query(
        r#"
        INSERT INTO flora_core.user_device_recovery_envelopes
            (user_uuid, key_epoch_id, target_device_uuid, source_device_uuid,
             recovery_request_id, transferred_key_epoch_ids, envelope_canonical_json,
             request_body_hash, created_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT ON CONSTRAINT pk_user_device_recovery_envelopes DO UPDATE SET
            source_device_uuid = EXCLUDED.source_device_uuid,
            recovery_request_id = EXCLUDED.recovery_request_id,
            transferred_key_epoch_ids = EXCLUDED.transferred_key_epoch_ids,
            envelope_canonical_json = EXCLUDED.envelope_canonical_json,
            request_body_hash = EXCLUDED.request_body_hash,
            created_at = EXCLUDED.created_at,
            expires_at = EXCLUDED.expires_at
        "#,
    )
    .bind(user_uuid)
    .bind(key_epoch_id)
    .bind(target_device_uuid)
    .bind(source_device_uuid)
    .bind(recovery_request_id)
    .bind(transferred_key_epoch_ids)
    .bind(envelope_canonical_json)
    .bind(&body_hash)
    .bind(now)
    .bind(expires_at)
    .execute(&mut *tx)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    tx.commit()
        .await
        .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;
    Ok(expires_at)
}

/// Живой (неистёкший) конверт для target-устройства; истёкшие записи удаляются лениво.
pub async fn fetch_recovery_envelope(
    pool: &PgPool,
    user_uuid: Uuid,
    key_epoch_id: Uuid,
    target_device_uuid: Uuid,
) -> Result<Option<StoredRecoveryEnvelopeRow>, E2eEpochRepoError> {
    let row: Option<StoredRecoveryEnvelopeRow> = sqlx::query_as(
        r#"
        SELECT source_device_uuid, recovery_request_id, transferred_key_epoch_ids,
               envelope_canonical_json, request_body_hash, created_at, expires_at
        FROM flora_core.user_device_recovery_envelopes
        WHERE user_uuid = $1 AND key_epoch_id = $2 AND target_device_uuid = $3
        "#,
    )
    .bind(user_uuid)
    .bind(key_epoch_id)
    .bind(target_device_uuid)
    .fetch_optional(pool)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    let Some(row) = row else { return Ok(None) };
    if row.expires_at <= Utc::now() {
        sqlx::query(
            r#"
            DELETE FROM flora_core.user_device_recovery_envelopes
            WHERE user_uuid = $1 AND key_epoch_id = $2 AND target_device_uuid = $3
              AND expires_at <= NOW()
            "#,
        )
        .bind(user_uuid)
        .bind(key_epoch_id)
        .bind(target_device_uuid)
        .execute(pool)
        .await
        .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;
        return Ok(None);
    }
    Ok(Some(row))
}

fn compute_body_hash(input: &str) -> String {
    hex::encode(Sha256::digest(input.as_bytes()))
}
