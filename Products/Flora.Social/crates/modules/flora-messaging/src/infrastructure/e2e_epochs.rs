//! E2E epochs, unlock-complete, device keys — opaque store + Ed25519 signature verification.

use std::collections::{HashMap, HashSet};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use flora_messaging_contracts::{
    AddPendingDeviceRequestDto, CreateEpochRequestDto, DeviceKeyEntryDto, KeyBackupPayloadDto,
    UnlockChallengeResponseDto, UnlockCompleteRequestDto,
};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use super::e2e::E2eAccountStateRow;

const CHALLENGE_TTL_MINUTES: i64 = 15;

#[derive(Debug, Clone)]
pub enum E2eEpochRepoError {
    AccountNotInRequiredState(String),
    NotFound(String),
    RecoveredEpochsEmpty,
    SignatureInvalid(String),
    ChallengeExpiredOrUsed(String),
    EpochSetHashUnchanged,
    Forbidden(String),
    IdempotencyConflict(String),
    Conflict(String),
    Internal(String),
}

pub async fn create_epoch(
    pool: &PgPool,
    user_uuid: Uuid,
    request: &CreateEpochRequestDto,
) -> Result<(), E2eEpochRepoError> {
    let body_hash = compute_body_hash(&format!(
        "{}:{}:{}",
        request.idempotency_key,
        request.new_key_epoch_id,
        request.new_epoch_account_identity_public_key_base64_url
    ));
    match check_idempotency(
        pool,
        request.idempotency_key,
        user_uuid,
        "epochs",
        &body_hash,
    )
    .await?
    {
        IdempotencyCheck::Replay => return Ok(()),
        IdempotencyCheck::Conflict(msg) => {
            return Err(E2eEpochRepoError::IdempotencyConflict(msg));
        }
        IdempotencyCheck::NotSeen => {}
    }

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    let state: Option<E2eAccountStateRow> = sqlx::query_as(
        r#"
        SELECT state, freeze, updated_at
        FROM flora_core.user_e2e_account_states
        WHERE user_uuid = $1
        FOR UPDATE
        "#,
    )
    .bind(user_uuid)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    let state = state.ok_or_else(|| {
        E2eEpochRepoError::AccountNotInRequiredState(format!(
            "POST epochs is only allowed when account state = locked. Current: not_initialized"
        ))
    })?;

    if state.state != "Locked" {
        return Err(E2eEpochRepoError::AccountNotInRequiredState(format!(
            "POST epochs is only allowed when account state = locked. Current: {}",
            db_state_to_api(&state.state)
        )));
    }

    let epoch_exists: Option<(Uuid,)> = sqlx::query_as(
        "SELECT key_epoch_id FROM flora_core.key_epoch_public_identities WHERE user_uuid = $1 AND key_epoch_id = $2",
    )
    .bind(user_uuid)
    .bind(request.new_key_epoch_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    if epoch_exists.is_some() {
        return Err(E2eEpochRepoError::Conflict(
            "The provided newKeyEpochId already exists as an active epoch for this user.".into(),
        ));
    }

    let now = Utc::now();
    let kb = &request.key_backup;

    let existing_backup: Option<KeyBackupRevisionRow> = sqlx::query_as(
        r#"
        SELECT backup_revision, epoch_set_hash_base64url
        FROM flora_core.user_e2e_key_backups
        WHERE user_uuid = $1
        "#,
    )
    .bind(user_uuid)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    if let Some(existing) = &existing_backup {
        if kb.backup_revision <= existing.backup_revision {
            return Err(E2eEpochRepoError::Conflict(
                "keyBackup.backupRevision must be greater than the current revision.".into(),
            ));
        }
    }

    upsert_key_backup_tx(&mut tx, user_uuid, kb, now).await?;

    sqlx::query(
        r#"
        INSERT INTO flora_core.key_epoch_public_identities
            (user_uuid, key_epoch_id, epoch_account_identity_public_key_base64url, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $4)
        "#,
    )
    .bind(user_uuid)
    .bind(request.new_key_epoch_id)
    .bind(&request.new_epoch_account_identity_public_key_base64_url)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    let device_uuid = Uuid::now_v7();
    sqlx::query(
        r#"
        INSERT INTO flora_core.user_device_keys
            (device_uuid, user_uuid, key_epoch_id, display_name,
             signing_public_key_base64url, agreement_public_key_base64url,
             status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'Active', $7)
        "#,
    )
    .bind(device_uuid)
    .bind(user_uuid)
    .bind(request.new_key_epoch_id)
    .bind(request.new_device_display_name.as_deref().unwrap_or(""))
    .bind(&request.new_device_signing_public_key_base64_url)
    .bind(&request.new_device_agreement_public_key_base64_url)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    sqlx::query(
        r#"
        UPDATE flora_core.user_e2e_account_states
        SET state = 'ActiveNewEpoch', updated_at = $2
        WHERE user_uuid = $1
        "#,
    )
    .bind(user_uuid)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    tx.commit()
        .await
        .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    record_idempotency(
        pool,
        request.idempotency_key,
        user_uuid,
        "epochs",
        &body_hash,
    )
    .await?;
    Ok(())
}

pub async fn request_unlock_challenge(
    pool: &PgPool,
    user_uuid: Uuid,
) -> Result<UnlockChallengeResponseDto, E2eEpochRepoError> {
    let state = sqlx::query_as::<_, E2eAccountStateRow>(
        r#"
        SELECT state, freeze, updated_at
        FROM flora_core.user_e2e_account_states
        WHERE user_uuid = $1
        "#,
    )
    .bind(user_uuid)
    .fetch_optional(pool)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    if state.as_ref().map(|s| s.state.as_str()) != Some("Recovering") {
        return Err(E2eEpochRepoError::AccountNotInRequiredState(
            "unlock-complete/challenge is only allowed when account state = recovering.".into(),
        ));
    }

    let challenge_id = Uuid::now_v7();
    let reset_request_id = Uuid::now_v7();
    let expires_at = Utc::now() + Duration::minutes(CHALLENGE_TTL_MINUTES);
    let preview = format!(
        "flora.messaging.unlock-complete.v1 | {user_uuid} | {reset_request_id} | {challenge_id} | \
         <backupKeyId> | <backupRevision> | <epochSetHashBase64Url> | <recoveredKeyEpochIds_sorted>"
    );

    sqlx::query(
        r#"
        INSERT INTO flora_core.user_e2e_unlock_challenges
            (challenge_id, user_uuid, reset_request_id, canonical_payload_preview,
             expires_at, is_used, created_at)
        VALUES ($1, $2, $3, $4, $5, false, $6)
        "#,
    )
    .bind(challenge_id)
    .bind(user_uuid)
    .bind(reset_request_id)
    .bind(&preview)
    .bind(expires_at)
    .bind(Utc::now())
    .execute(pool)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    Ok(UnlockChallengeResponseDto {
        challenge_id,
        reset_request_id,
        expires_at: format_utc(expires_at),
        canonical_payload_preview: preview,
    })
}

pub async fn unlock_complete(
    pool: &PgPool,
    user_uuid: Uuid,
    request: &UnlockCompleteRequestDto,
) -> Result<(), E2eEpochRepoError> {
    if request.recovered_key_epoch_ids.is_empty() {
        return Err(E2eEpochRepoError::RecoveredEpochsEmpty);
    }

    let recovered_set: HashSet<Uuid> = request.recovered_key_epoch_ids.iter().copied().collect();
    let identity_set: HashSet<Uuid> = request
        .epoch_identity_public_keys
        .iter()
        .map(|e| e.key_epoch_id)
        .collect();
    let sig_set: HashSet<Uuid> = request
        .epoch_unlock_signatures
        .iter()
        .map(|e| e.key_epoch_id)
        .collect();

    if recovered_set != identity_set || recovered_set != sig_set {
        return Err(E2eEpochRepoError::Conflict(
            "recoveredKeyEpochIds, epochIdentityPublicKeys, and epochUnlockSignatures must cover exactly the same set of keyEpochIds.".into(),
        ));
    }

    let body_hash = compute_body_hash(&format!(
        "{}:{}:{}",
        request.idempotency_key, request.challenge_id, request.key_backup.epoch_set_hash_base64_url
    ));
    match check_idempotency(
        pool,
        request.idempotency_key,
        user_uuid,
        "unlock-complete",
        &body_hash,
    )
    .await?
    {
        IdempotencyCheck::Replay => return Ok(()),
        IdempotencyCheck::Conflict(msg) => {
            return Err(E2eEpochRepoError::IdempotencyConflict(msg));
        }
        IdempotencyCheck::NotSeen => {}
    }

    if request
        .recovery_unlock_token
        .as_deref()
        .unwrap_or("")
        .is_empty()
        && request
            .trusted_device_approval_token
            .as_deref()
            .unwrap_or("")
            .is_empty()
    {
        return Err(E2eEpochRepoError::Forbidden(
            "One of recoveryUnlockToken or trustedDeviceApprovalToken is required.".into(),
        ));
    }

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    let state: Option<E2eAccountStateRow> = sqlx::query_as(
        r#"
        SELECT state, freeze, updated_at
        FROM flora_core.user_e2e_account_states
        WHERE user_uuid = $1
        FOR UPDATE
        "#,
    )
    .bind(user_uuid)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    if state.as_ref().map(|s| s.state.as_str()) != Some("Recovering") {
        return Err(E2eEpochRepoError::AccountNotInRequiredState(
            "unlock-complete is only allowed when account state = recovering.".into(),
        ));
    }

    let challenge: Option<UnlockChallengeRow> = sqlx::query_as(
        r#"
        SELECT challenge_id, reset_request_id, expires_at, is_used
        FROM flora_core.user_e2e_unlock_challenges
        WHERE challenge_id = $1 AND user_uuid = $2
        FOR UPDATE
        "#,
    )
    .bind(request.challenge_id)
    .bind(user_uuid)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    let challenge = challenge
        .ok_or_else(|| E2eEpochRepoError::ChallengeExpiredOrUsed("Challenge not found.".into()))?;

    if challenge.is_used {
        return Err(E2eEpochRepoError::ChallengeExpiredOrUsed(
            "Challenge has already been used.".into(),
        ));
    }
    if Utc::now() > challenge.expires_at {
        return Err(E2eEpochRepoError::ChallengeExpiredOrUsed(
            "Challenge has expired.".into(),
        ));
    }
    if challenge.reset_request_id != request.reset_request_id {
        return Err(E2eEpochRepoError::ChallengeExpiredOrUsed(
            "challengeId does not match resetRequestId.".into(),
        ));
    }

    let existing_identities: Vec<EpochIdentityDbRow> = sqlx::query_as(
        r#"
        SELECT key_epoch_id, epoch_account_identity_public_key_base64url
        FROM flora_core.key_epoch_public_identities
        WHERE user_uuid = $1 AND key_epoch_id = ANY($2)
        "#,
    )
    .bind(user_uuid)
    .bind(&request.recovered_key_epoch_ids)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    let existing_identity_map: HashMap<Uuid, String> = existing_identities
        .into_iter()
        .map(|r| {
            (
                r.key_epoch_id,
                r.epoch_account_identity_public_key_base64url,
            )
        })
        .collect();

    let identity_key_map: HashMap<Uuid, &str> = request
        .epoch_identity_public_keys
        .iter()
        .map(|e| (e.key_epoch_id, e.value_base64_url.as_str()))
        .collect();
    let sig_map: HashMap<Uuid, &str> = request
        .epoch_unlock_signatures
        .iter()
        .map(|e| (e.key_epoch_id, e.value_base64_url.as_str()))
        .collect();

    let kb = &request.key_backup;
    let canonical_payload = build_canonical_unlock_payload(
        user_uuid,
        request.reset_request_id,
        request.challenge_id,
        kb.backup_key_id,
        kb.backup_revision,
        &kb.epoch_set_hash_base64_url,
        &request.recovered_key_epoch_ids,
    );

    for epoch_id in &recovered_set {
        let identity_public_key = identity_key_map
            .get(epoch_id)
            .copied()
            .ok_or_else(|| E2eEpochRepoError::Conflict("Missing epoch identity key.".into()))?;
        let signature = sig_map
            .get(epoch_id)
            .copied()
            .ok_or_else(|| E2eEpochRepoError::Conflict("Missing epoch unlock signature.".into()))?;

        if let Some(stored) = existing_identity_map.get(epoch_id) {
            if stored != identity_public_key {
                return Err(E2eEpochRepoError::Conflict(format!(
                    "Epoch {epoch_id}: submitted epochAccountIdentityPublicKey conflicts with the stored key."
                )));
            }
        }

        if !verify_ed25519_signature(identity_public_key, &canonical_payload, signature) {
            return Err(E2eEpochRepoError::SignatureInvalid(format!(
                "Ed25519 signature verification failed for epoch {epoch_id}."
            )));
        }
    }

    let existing_backup: Option<KeyBackupRevisionRow> = sqlx::query_as(
        r#"
        SELECT backup_revision, epoch_set_hash_base64url
        FROM flora_core.user_e2e_key_backups
        WHERE user_uuid = $1
        "#,
    )
    .bind(user_uuid)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    if let Some(existing) = &existing_backup {
        if kb.backup_revision <= existing.backup_revision {
            return Err(E2eEpochRepoError::Conflict(
                "keyBackup.backupRevision must be greater than the current revision.".into(),
            ));
        }
        if existing.epoch_set_hash_base64url == kb.epoch_set_hash_base64_url {
            return Err(E2eEpochRepoError::EpochSetHashUnchanged);
        }
    }

    let now = Utc::now();
    upsert_key_backup_tx(&mut tx, user_uuid, kb, now).await?;

    for epoch_id in &recovered_set {
        if !existing_identity_map.contains_key(epoch_id) {
            let identity_public_key = identity_key_map[epoch_id];
            sqlx::query(
                r#"
                INSERT INTO flora_core.key_epoch_public_identities
                    (user_uuid, key_epoch_id, epoch_account_identity_public_key_base64url,
                     created_at, updated_at)
                VALUES ($1, $2, $3, $4, $4)
                "#,
            )
            .bind(user_uuid)
            .bind(epoch_id)
            .bind(identity_public_key)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;
        } else {
            sqlx::query(
                r#"
                UPDATE flora_core.key_epoch_public_identities
                SET updated_at = $3
                WHERE user_uuid = $1 AND key_epoch_id = $2
                "#,
            )
            .bind(user_uuid)
            .bind(epoch_id)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;
        }
    }

    let device_uuid = Uuid::now_v7();
    sqlx::query(
        r#"
        INSERT INTO flora_core.user_device_keys
            (device_uuid, user_uuid, key_epoch_id, display_name,
             signing_public_key_base64url, agreement_public_key_base64url,
             status, created_at)
        VALUES ($1, $2, $3, '', $4, $5, 'Active', $6)
        "#,
    )
    .bind(device_uuid)
    .bind(user_uuid)
    .bind(kb.primary_key_epoch_id)
    .bind(&request.new_device_signing_public_key_base64_url)
    .bind(&request.new_device_agreement_public_key_base64_url)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    sqlx::query(
        r#"
        UPDATE flora_core.user_e2e_unlock_challenges
        SET is_used = true
        WHERE challenge_id = $1
        "#,
    )
    .bind(request.challenge_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    sqlx::query(
        r#"
        UPDATE flora_core.user_e2e_account_states
        SET state = 'Active', updated_at = $2
        WHERE user_uuid = $1
        "#,
    )
    .bind(user_uuid)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    tx.commit()
        .await
        .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    record_idempotency(
        pool,
        request.idempotency_key,
        user_uuid,
        "unlock-complete",
        &body_hash,
    )
    .await?;
    Ok(())
}

pub async fn add_pending_device(
    pool: &PgPool,
    user_uuid: Uuid,
    key_epoch_id: Uuid,
    request: &AddPendingDeviceRequestDto,
) -> Result<Uuid, E2eEpochRepoError> {
    let state = sqlx::query_as::<_, E2eAccountStateRow>(
        r#"
        SELECT state, freeze, updated_at
        FROM flora_core.user_e2e_account_states
        WHERE user_uuid = $1
        "#,
    )
    .bind(user_uuid)
    .fetch_optional(pool)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    let allowed = matches!(
        state.as_ref().map(|s| s.state.as_str()),
        Some("Active") | Some("ActiveNewEpoch")
    );
    if !allowed {
        return Err(E2eEpochRepoError::AccountNotInRequiredState(
            "Adding a pending device is only allowed when account state = active or active_new_epoch."
                .into(),
        ));
    }

    let epoch_exists: Option<(Uuid,)> = sqlx::query_as(
        "SELECT key_epoch_id FROM flora_core.key_epoch_public_identities WHERE user_uuid = $1 AND key_epoch_id = $2",
    )
    .bind(user_uuid)
    .bind(key_epoch_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    if epoch_exists.is_none() {
        return Err(E2eEpochRepoError::NotFound(format!(
            "Key epoch {key_epoch_id} not found for this user."
        )));
    }

    let now = Utc::now();
    let device_uuid = Uuid::now_v7();
    sqlx::query(
        r#"
        INSERT INTO flora_core.user_device_keys
            (device_uuid, user_uuid, key_epoch_id, display_name,
             signing_public_key_base64url, agreement_public_key_base64url,
             status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'Pending', $7)
        "#,
    )
    .bind(device_uuid)
    .bind(user_uuid)
    .bind(key_epoch_id)
    .bind(request.display_name.as_deref().unwrap_or(""))
    .bind(&request.signing_public_key_base64_url)
    .bind(&request.agreement_public_key_base64_url)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    Ok(device_uuid)
}

pub async fn fetch_devices(
    pool: &PgPool,
    user_uuid: Uuid,
    key_epoch_id: Uuid,
) -> Result<Vec<DeviceKeyEntryDto>, String> {
    let rows: Vec<DeviceKeyDbRow> = sqlx::query_as(
        r#"
        SELECT device_uuid, key_epoch_id, display_name,
               signing_public_key_base64url, agreement_public_key_base64url,
               status, created_at, last_seen_at, revoked_at
        FROM flora_core.user_device_keys
        WHERE user_uuid = $1 AND key_epoch_id = $2
        ORDER BY created_at ASC
        "#,
    )
    .bind(user_uuid)
    .bind(key_epoch_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn revoke_device(
    pool: &PgPool,
    user_uuid: Uuid,
    key_epoch_id: Uuid,
    device_uuid: Uuid,
) -> Result<(), E2eEpochRepoError> {
    let device: Option<DeviceStatusRow> = sqlx::query_as(
        r#"
        SELECT status
        FROM flora_core.user_device_keys
        WHERE device_uuid = $1 AND user_uuid = $2 AND key_epoch_id = $3
        "#,
    )
    .bind(device_uuid)
    .bind(user_uuid)
    .bind(key_epoch_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    let device = device.ok_or_else(|| {
        E2eEpochRepoError::NotFound(format!(
            "Device {device_uuid} not found for epoch {key_epoch_id}."
        ))
    })?;

    if device.status == "Revoked" {
        return Ok(());
    }

    sqlx::query(
        r#"
        UPDATE flora_core.user_device_keys
        SET status = 'Revoked', revoked_at = $4
        WHERE device_uuid = $1 AND user_uuid = $2 AND key_epoch_id = $3
        "#,
    )
    .bind(device_uuid)
    .bind(user_uuid)
    .bind(key_epoch_id)
    .bind(Utc::now())
    .execute(pool)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;
    Ok(())
}

async fn upsert_key_backup_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_uuid: Uuid,
    kb: &KeyBackupPayloadDto,
    now: DateTime<Utc>,
) -> Result<(), E2eEpochRepoError> {
    let existing: Option<(Uuid,)> = sqlx::query_as(
        "SELECT user_uuid FROM flora_core.user_e2e_key_backups WHERE user_uuid = $1",
    )
    .bind(user_uuid)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    if existing.is_none() {
        sqlx::query(
            r#"
            INSERT INTO flora_core.user_e2e_key_backups
                (user_uuid, version, backup_revision, backup_key_id, primary_key_epoch_id,
                 epoch_set_revision, epoch_set_hash_base64url,
                 kdf_name, kdf_memory_kib, kdf_iterations, kdf_parallelism, kdf_salt_base64url,
                 aead_name, aead_nonce_base64url, ciphertext_base64url, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
            "#,
        )
        .bind(user_uuid)
        .bind(kb.version)
        .bind(kb.backup_revision)
        .bind(kb.backup_key_id)
        .bind(kb.primary_key_epoch_id)
        .bind(kb.epoch_set_revision)
        .bind(&kb.epoch_set_hash_base64_url)
        .bind(&kb.kdf.name)
        .bind(kb.kdf.memory_ki_b)
        .bind(kb.kdf.iterations)
        .bind(kb.kdf.parallelism)
        .bind(&kb.kdf.salt_base64_url)
        .bind(&kb.aead.name)
        .bind(&kb.aead.nonce_base64_url)
        .bind(&kb.ciphertext_base64_url)
        .bind(now)
        .execute(&mut **tx)
        .await
        .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;
    } else {
        sqlx::query(
            r#"
            UPDATE flora_core.user_e2e_key_backups SET
                version = $2, backup_revision = $3, backup_key_id = $4,
                primary_key_epoch_id = $5, epoch_set_revision = $6,
                epoch_set_hash_base64url = $7,
                kdf_name = $8, kdf_memory_kib = $9, kdf_iterations = $10,
                kdf_parallelism = $11, kdf_salt_base64url = $12,
                aead_name = $13, aead_nonce_base64url = $14,
                ciphertext_base64url = $15, updated_at = $16
            WHERE user_uuid = $1
            "#,
        )
        .bind(user_uuid)
        .bind(kb.version)
        .bind(kb.backup_revision)
        .bind(kb.backup_key_id)
        .bind(kb.primary_key_epoch_id)
        .bind(kb.epoch_set_revision)
        .bind(&kb.epoch_set_hash_base64_url)
        .bind(&kb.kdf.name)
        .bind(kb.kdf.memory_ki_b)
        .bind(kb.kdf.iterations)
        .bind(kb.kdf.parallelism)
        .bind(&kb.kdf.salt_base64_url)
        .bind(&kb.aead.name)
        .bind(&kb.aead.nonce_base64_url)
        .bind(&kb.ciphertext_base64_url)
        .bind(now)
        .execute(&mut **tx)
        .await
        .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;
    }
    Ok(())
}

async fn check_idempotency(
    pool: &PgPool,
    idempotency_key: Uuid,
    user_uuid: Uuid,
    operation: &str,
    body_hash: &str,
) -> Result<IdempotencyCheck, E2eEpochRepoError> {
    let existing: Option<IdempotencyRow> = sqlx::query_as(
        r#"
        SELECT user_uuid, operation, request_body_hash
        FROM flora_core.user_e2e_idempotency_records
        WHERE idempotency_key = $1
        "#,
    )
    .bind(idempotency_key)
    .fetch_optional(pool)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;

    let Some(existing) = existing else {
        return Ok(IdempotencyCheck::NotSeen);
    };

    if existing.user_uuid != user_uuid || existing.operation != operation {
        return Ok(IdempotencyCheck::Conflict(
            "Idempotency key belongs to a different user or operation.".into(),
        ));
    }
    if !existing.request_body_hash.eq_ignore_ascii_case(body_hash) {
        return Ok(IdempotencyCheck::Conflict(
            "Idempotency key was already used with a different request body.".into(),
        ));
    }
    Ok(IdempotencyCheck::Replay)
}

enum IdempotencyCheck {
    NotSeen,
    Replay,
    Conflict(String),
}

async fn record_idempotency(
    pool: &PgPool,
    idempotency_key: Uuid,
    user_uuid: Uuid,
    operation: &str,
    body_hash: &str,
) -> Result<(), E2eEpochRepoError> {
    let now = Utc::now();
    sqlx::query(
        r#"
        INSERT INTO flora_core.user_e2e_idempotency_records
            (idempotency_key, user_uuid, operation, request_body_hash, created_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (idempotency_key) DO NOTHING
        "#,
    )
    .bind(idempotency_key)
    .bind(user_uuid)
    .bind(operation)
    .bind(body_hash)
    .bind(now)
    .bind(now + Duration::days(7))
    .execute(pool)
    .await
    .map_err(|e| E2eEpochRepoError::Internal(e.to_string()))?;
    Ok(())
}

fn build_canonical_unlock_payload(
    user_uuid: Uuid,
    reset_request_id: Uuid,
    challenge_id: Uuid,
    backup_key_id: Uuid,
    backup_revision: i32,
    epoch_set_hash_base64_url: &str,
    recovered_key_epoch_ids: &[Uuid],
) -> String {
    let mut sorted: Vec<Uuid> = recovered_key_epoch_ids.to_vec();
    sorted.sort();
    let sorted_ids: String = sorted
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "flora.messaging.unlock-complete.v1 | {user_uuid} | {reset_request_id} | {challenge_id} | \
         {backup_key_id} | {backup_revision} | {epoch_set_hash_base64_url} | {sorted_ids}"
    )
}

fn verify_ed25519_signature(
    public_key_base64_url: &str,
    message: &str,
    signature_base64_url: &str,
) -> bool {
    let Ok(pk_bytes) = decode_base64_url(public_key_base64_url) else {
        return false;
    };
    let Ok(sig_bytes) = decode_base64_url(signature_base64_url) else {
        return false;
    };
    let Ok(pk_array): Result<[u8; 32], _> = pk_bytes.try_into() else {
        return false;
    };
    let Ok(sig_array): Result<[u8; 64], _> = sig_bytes.try_into() else {
        return false;
    };
    let Ok(vk) = VerifyingKey::from_bytes(&pk_array) else {
        return false;
    };
    vk.verify(message.as_bytes(), &Signature::from_bytes(&sig_array))
        .is_ok()
}

fn decode_base64_url(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    URL_SAFE_NO_PAD.decode(s)
}

fn compute_body_hash(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    hex::encode(digest)
}

fn db_state_to_api(state: &str) -> String {
    match state {
        "NotInitialized" => "not_initialized".into(),
        "Active" => "active".into(),
        "Locked" => "locked".into(),
        "ActiveNewEpoch" => "active_new_epoch".into(),
        "Recovering" => "recovering".into(),
        "Rotating" => "rotating".into(),
        "Frozen" => "frozen".into(),
        other => other.to_ascii_lowercase(),
    }
}

fn format_utc(dt: DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[derive(sqlx::FromRow)]
struct KeyBackupRevisionRow {
    backup_revision: i32,
    epoch_set_hash_base64url: String,
}

#[derive(sqlx::FromRow)]
struct EpochIdentityDbRow {
    key_epoch_id: Uuid,
    epoch_account_identity_public_key_base64url: String,
}

#[derive(sqlx::FromRow)]
struct UnlockChallengeRow {
    reset_request_id: Uuid,
    expires_at: DateTime<Utc>,
    is_used: bool,
}

#[derive(sqlx::FromRow)]
struct DeviceKeyDbRow {
    device_uuid: Uuid,
    key_epoch_id: Uuid,
    display_name: String,
    signing_public_key_base64url: String,
    agreement_public_key_base64url: String,
    status: String,
    created_at: DateTime<Utc>,
    last_seen_at: Option<DateTime<Utc>>,
    revoked_at: Option<DateTime<Utc>>,
}

#[derive(sqlx::FromRow)]
struct DeviceStatusRow {
    status: String,
}

#[derive(sqlx::FromRow)]
struct IdempotencyRow {
    user_uuid: Uuid,
    operation: String,
    request_body_hash: String,
}

impl From<DeviceKeyDbRow> for DeviceKeyEntryDto {
    fn from(r: DeviceKeyDbRow) -> Self {
        Self {
            device_uuid: r.device_uuid,
            key_epoch_id: r.key_epoch_id,
            display_name: r.display_name,
            signing_public_key_base64_url: r.signing_public_key_base64url,
            agreement_public_key_base64_url: r.agreement_public_key_base64url,
            status: r.status.to_ascii_lowercase(),
            created_at: format_utc(r.created_at),
            last_seen_at: r.last_seen_at.map(format_utc),
            revoked_at: r.revoked_at.map(format_utc),
        }
    }
}
