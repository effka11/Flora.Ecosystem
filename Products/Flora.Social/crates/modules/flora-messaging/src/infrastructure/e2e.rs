//! E2E account state + password key backup — opaque ciphertext only (server never decrypts).
//! Also: legacy `user_e2e_keys` public-key store (ImportedSocialController parity).

use chrono::{DateTime, Utc};
use flora_messaging_contracts::{
    KeyBackupPayloadDto, PutKeyBackupRequestDto, RecoveryBackupMetaDto, RecoveryBackupPayloadDto,
};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct E2eAccountStateRow {
    pub state: String,
    pub freeze: bool,
    pub updated_at: DateTime<Utc>,
}

pub async fn fetch_account_state(
    pool: &PgPool,
    user_uuid: Uuid,
) -> Result<Option<E2eAccountStateRow>, String> {
    sqlx::query_as::<_, E2eAccountStateRow>(
        r#"
        -- "freeze" quoted: FREEZE is reserved in PostgreSQL 17+
        SELECT state, "freeze", updated_at
        FROM flora_core.user_e2e_account_states
        WHERE user_uuid = $1
        "#,
    )
    .bind(user_uuid)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())
}

pub async fn ensure_state_initialized(pool: &PgPool, user_uuid: Uuid) -> Result<(), String> {
    let now = Utc::now();
    sqlx::query(
        r#"
        INSERT INTO flora_core.user_e2e_account_states
            (user_uuid, state, "freeze", created_at, updated_at)
        VALUES ($1, 'NotInitialized', false, $2, $2)
        ON CONFLICT (user_uuid) DO NOTHING
        "#,
    )
    .bind(user_uuid)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn fetch_key_backup(
    pool: &PgPool,
    user_uuid: Uuid,
) -> Result<Option<KeyBackupPayloadDto>, String> {
    let row: Option<KeyBackupDbRow> = sqlx::query_as(
        r#"
        SELECT version, backup_revision, backup_key_id, user_uuid, primary_key_epoch_id,
               epoch_set_revision, epoch_set_hash_base64url,
               kdf_name, kdf_memory_kib, kdf_iterations, kdf_parallelism, kdf_salt_base64url,
               aead_name, aead_nonce_base64url, ciphertext_base64url
        FROM flora_core.user_e2e_key_backups
        WHERE user_uuid = $1
        "#,
    )
    .bind(user_uuid)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.map(Into::into))
}

pub async fn put_key_backup(
    pool: &PgPool,
    user_uuid: Uuid,
    request: &PutKeyBackupRequestDto,
) -> Result<(), PutKeyBackupRepoError> {
    let kb = &request.key_backup;
    ensure_state_initialized(pool, user_uuid)
        .await
        .map_err(PutKeyBackupRepoError::Internal)?;

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| PutKeyBackupRepoError::Internal(e.to_string()))?;

    let state: E2eAccountStateRow = sqlx::query_as(
        r#"
        SELECT state, "freeze", updated_at
        FROM flora_core.user_e2e_account_states
        WHERE user_uuid = $1
        FOR UPDATE
        "#,
    )
    .bind(user_uuid)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| PutKeyBackupRepoError::Internal(e.to_string()))?;

    if state.freeze {
        return Err(PutKeyBackupRepoError::AccountFrozen);
    }
    if state.state == "Locked" {
        return Err(PutKeyBackupRepoError::AccountLocked);
    }

    let now = Utc::now();
    let existing: Option<(Uuid,)> = sqlx::query_as(
        "SELECT user_uuid FROM flora_core.user_e2e_key_backups WHERE user_uuid = $1",
    )
    .bind(user_uuid)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| PutKeyBackupRepoError::Internal(e.to_string()))?;

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
        .execute(&mut *tx)
        .await
        .map_err(|e| PutKeyBackupRepoError::Internal(e.to_string()))?;
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
        .execute(&mut *tx)
        .await
        .map_err(|e| PutKeyBackupRepoError::Internal(e.to_string()))?;
    }

    if !request.epoch_identity_public_keys.is_empty() {
        let epoch_ids: Vec<Uuid> = request
            .epoch_identity_public_keys
            .iter()
            .map(|e| e.key_epoch_id)
            .collect();
        let existing_epochs: Vec<EpochIdentityDbRow> = sqlx::query_as(
            r#"
            SELECT key_epoch_id, epoch_account_identity_public_key_base64url
            FROM flora_core.key_epoch_public_identities
            WHERE user_uuid = $1 AND key_epoch_id = ANY($2)
            "#,
        )
        .bind(user_uuid)
        .bind(&epoch_ids)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| PutKeyBackupRepoError::Internal(e.to_string()))?;

        let existing_map: std::collections::HashMap<Uuid, String> = existing_epochs
            .into_iter()
            .map(|r| {
                (
                    r.key_epoch_id,
                    r.epoch_account_identity_public_key_base64url,
                )
            })
            .collect();

        for entry in &request.epoch_identity_public_keys {
            if let Some(stored) = existing_map.get(&entry.key_epoch_id) {
                if stored != &entry.epoch_account_identity_public_key_base64_url {
                    return Err(PutKeyBackupRepoError::Conflict(format!(
                        "Epoch {}: public key conflicts with already-stored key.",
                        entry.key_epoch_id
                    )));
                }
            } else {
                sqlx::query(
                    r#"
                    INSERT INTO flora_core.key_epoch_public_identities
                        (user_uuid, key_epoch_id, epoch_account_identity_public_key_base64url,
                         created_at, updated_at)
                    VALUES ($1, $2, $3, $4, $4)
                    "#,
                )
                .bind(user_uuid)
                .bind(entry.key_epoch_id)
                .bind(&entry.epoch_account_identity_public_key_base64_url)
                .bind(now)
                .execute(&mut *tx)
                .await
                .map_err(|e| PutKeyBackupRepoError::Internal(e.to_string()))?;
            }
        }
    }

    if state.state == "NotInitialized" {
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
        .map_err(|e| PutKeyBackupRepoError::Internal(e.to_string()))?;
    }

    tx.commit()
        .await
        .map_err(|e| PutKeyBackupRepoError::Internal(e.to_string()))?;
    Ok(())
}

pub async fn fetch_recovery_backups(
    pool: &PgPool,
    user_uuid: Uuid,
) -> Result<Vec<RecoveryBackupMetaDto>, String> {
    let rows: Vec<RecoveryMetaDbRow> = sqlx::query_as(
        r#"
        SELECT recovery_key_id, recovery_revision, primary_key_epoch_id,
               epoch_set_revision, epoch_set_hash_base64url,
               wordlist_id, words_count, created_at, updated_at, used_at
        FROM flora_core.user_e2e_recovery_backups
        WHERE user_uuid = $1
        ORDER BY created_at DESC
        "#,
    )
    .bind(user_uuid)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn fetch_recovery_backup(
    pool: &PgPool,
    user_uuid: Uuid,
    recovery_key_id: Uuid,
) -> Result<Option<RecoveryBackupPayloadDto>, String> {
    let row: Option<RecoveryBackupDbRow> = sqlx::query_as(
        r#"
        SELECT version, recovery_revision, recovery_key_id, user_uuid, primary_key_epoch_id,
               epoch_set_revision, epoch_set_hash_base64url,
               wordlist_id, words_count,
               kdf_name, kdf_memory_kib, kdf_iterations, kdf_parallelism, kdf_salt_base64url,
               aead_name, aead_nonce_base64url, ciphertext_base64url
        FROM flora_core.user_e2e_recovery_backups
        WHERE user_uuid = $1 AND recovery_key_id = $2
        "#,
    )
    .bind(user_uuid)
    .bind(recovery_key_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.map(Into::into))
}

pub async fn put_recovery_backup(
    pool: &PgPool,
    user_uuid: Uuid,
    payload: &RecoveryBackupPayloadDto,
) -> Result<(), String> {
    let now = Utc::now();
    let existing: Option<(Uuid,)> = sqlx::query_as(
        "SELECT recovery_key_id FROM flora_core.user_e2e_recovery_backups WHERE user_uuid = $1 AND recovery_key_id = $2",
    )
    .bind(user_uuid)
    .bind(payload.recovery_key_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    if existing.is_none() {
        sqlx::query(
            r#"
            INSERT INTO flora_core.user_e2e_recovery_backups
                (recovery_key_id, user_uuid, version, recovery_revision, primary_key_epoch_id,
                 epoch_set_revision, epoch_set_hash_base64url,
                 wordlist_id, words_count,
                 kdf_name, kdf_memory_kib, kdf_iterations, kdf_parallelism, kdf_salt_base64url,
                 aead_name, aead_nonce_base64url, ciphertext_base64url, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)
            "#,
        )
        .bind(payload.recovery_key_id)
        .bind(user_uuid)
        .bind(payload.version)
        .bind(payload.recovery_revision)
        .bind(payload.primary_key_epoch_id)
        .bind(payload.epoch_set_revision)
        .bind(&payload.epoch_set_hash_base64_url)
        .bind(&payload.wordlist.id)
        .bind(payload.wordlist.words_count)
        .bind(&payload.kdf.name)
        .bind(payload.kdf.memory_ki_b)
        .bind(payload.kdf.iterations)
        .bind(payload.kdf.parallelism)
        .bind(&payload.kdf.salt_base64_url)
        .bind(&payload.aead.name)
        .bind(&payload.aead.nonce_base64_url)
        .bind(&payload.ciphertext_base64_url)
        .bind(now)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    } else {
        sqlx::query(
            r#"
            UPDATE flora_core.user_e2e_recovery_backups SET
                version = $3, recovery_revision = $4, primary_key_epoch_id = $5,
                epoch_set_revision = $6, epoch_set_hash_base64url = $7,
                wordlist_id = $8, words_count = $9,
                kdf_name = $10, kdf_memory_kib = $11, kdf_iterations = $12,
                kdf_parallelism = $13, kdf_salt_base64url = $14,
                aead_name = $15, aead_nonce_base64url = $16,
                ciphertext_base64url = $17, updated_at = $18
            WHERE user_uuid = $1 AND recovery_key_id = $2
            "#,
        )
        .bind(user_uuid)
        .bind(payload.recovery_key_id)
        .bind(payload.version)
        .bind(payload.recovery_revision)
        .bind(payload.primary_key_epoch_id)
        .bind(payload.epoch_set_revision)
        .bind(&payload.epoch_set_hash_base64_url)
        .bind(&payload.wordlist.id)
        .bind(payload.wordlist.words_count)
        .bind(&payload.kdf.name)
        .bind(payload.kdf.memory_ki_b)
        .bind(payload.kdf.iterations)
        .bind(payload.kdf.parallelism)
        .bind(&payload.kdf.salt_base64_url)
        .bind(&payload.aead.name)
        .bind(&payload.aead.nonce_base64_url)
        .bind(&payload.ciphertext_base64_url)
        .bind(now)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Legacy user_e2e_keys (public key per user) ──────────────────────────────

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserE2eKeyRow {
    pub user_uuid: Uuid,
    pub public_key_base64: String,
    pub device_uuid: Option<Uuid>,
    pub updated_at: DateTime<Utc>,
}

pub async fn fetch_user_e2e_key(
    pool: &PgPool,
    user_uuid: Uuid,
) -> Result<Option<UserE2eKeyRow>, String> {
    sqlx::query_as::<_, UserE2eKeyRow>(
        r#"
        SELECT user_uuid, public_key_base64, device_uuid, updated_at
        FROM flora_core.user_e2e_keys
        WHERE user_uuid = $1
        "#,
    )
    .bind(user_uuid)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())
}

/// Batch public keys for legacy conversation list (C# GetConversations).
pub async fn fetch_user_e2e_keys_by_uuids(
    pool: &PgPool,
    user_uuids: &[Uuid],
) -> Result<Vec<(Uuid, String)>, String> {
    if user_uuids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<(Uuid, String)> = sqlx::query_as(
        r#"
        SELECT user_uuid, public_key_base64
        FROM flora_core.user_e2e_keys
        WHERE user_uuid = ANY($1)
        "#,
    )
    .bind(user_uuids)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub async fn insert_user_e2e_key(
    pool: &PgPool,
    user_uuid: Uuid,
    public_key_base64: &str,
    device_uuid: Uuid,
    updated_at: DateTime<Utc>,
) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO flora_core.user_e2e_keys
            (user_uuid, public_key_base64, device_uuid, updated_at)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(user_uuid)
    .bind(public_key_base64)
    .bind(device_uuid)
    .bind(updated_at)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn update_user_e2e_key(
    pool: &PgPool,
    user_uuid: Uuid,
    public_key_base64: &str,
    device_uuid: Option<Uuid>,
    updated_at: DateTime<Utc>,
) -> Result<(), String> {
    sqlx::query(
        r#"
        UPDATE flora_core.user_e2e_keys
        SET public_key_base64 = $2,
            device_uuid = $3,
            updated_at = $4
        WHERE user_uuid = $1
        "#,
    )
    .bind(user_uuid)
    .bind(public_key_base64)
    .bind(device_uuid)
    .bind(updated_at)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn lock_account(pool: &PgPool, user_uuid: Uuid) -> Result<(), String> {
    let state = fetch_account_state(pool, user_uuid).await?;
    if state.is_none() {
        return Ok(());
    }
    let state = state.unwrap();
    if state.state == "Locked" {
        return Ok(());
    }
    let now = Utc::now();
    sqlx::query(
        r#"
        UPDATE flora_core.user_e2e_account_states
        SET state = 'Locked', updated_at = $2
        WHERE user_uuid = $1
        "#,
    )
    .bind(user_uuid)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone)]
pub enum PutKeyBackupRepoError {
    AccountLocked,
    AccountFrozen,
    Forbidden,
    Conflict(String),
    Internal(String),
}

#[derive(sqlx::FromRow)]
struct KeyBackupDbRow {
    version: i32,
    backup_revision: i32,
    backup_key_id: Uuid,
    user_uuid: Uuid,
    primary_key_epoch_id: Uuid,
    epoch_set_revision: i32,
    epoch_set_hash_base64url: String,
    kdf_name: String,
    kdf_memory_kib: i32,
    kdf_iterations: i32,
    kdf_parallelism: i32,
    kdf_salt_base64url: String,
    aead_name: String,
    aead_nonce_base64url: String,
    ciphertext_base64url: String,
}

#[derive(sqlx::FromRow)]
struct EpochIdentityDbRow {
    key_epoch_id: Uuid,
    epoch_account_identity_public_key_base64url: String,
}

#[derive(sqlx::FromRow)]
struct RecoveryMetaDbRow {
    recovery_key_id: Uuid,
    recovery_revision: i32,
    primary_key_epoch_id: Uuid,
    epoch_set_revision: i32,
    epoch_set_hash_base64url: String,
    wordlist_id: String,
    words_count: i32,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    used_at: Option<DateTime<Utc>>,
}

#[derive(sqlx::FromRow)]
struct RecoveryBackupDbRow {
    version: i32,
    recovery_revision: i32,
    recovery_key_id: Uuid,
    user_uuid: Uuid,
    primary_key_epoch_id: Uuid,
    epoch_set_revision: i32,
    epoch_set_hash_base64url: String,
    wordlist_id: String,
    words_count: i32,
    kdf_name: String,
    kdf_memory_kib: i32,
    kdf_iterations: i32,
    kdf_parallelism: i32,
    kdf_salt_base64url: String,
    aead_name: String,
    aead_nonce_base64url: String,
    ciphertext_base64url: String,
}

impl From<KeyBackupDbRow> for KeyBackupPayloadDto {
    fn from(r: KeyBackupDbRow) -> Self {
        Self {
            version: r.version,
            backup_revision: r.backup_revision,
            backup_key_id: r.backup_key_id,
            user_uuid: r.user_uuid,
            primary_key_epoch_id: r.primary_key_epoch_id,
            epoch_set_revision: r.epoch_set_revision,
            epoch_set_hash_base64_url: r.epoch_set_hash_base64url,
            kdf: flora_messaging_contracts::KdfParamsDto {
                name: r.kdf_name,
                memory_ki_b: r.kdf_memory_kib,
                iterations: r.kdf_iterations,
                parallelism: r.kdf_parallelism,
                salt_base64_url: r.kdf_salt_base64url,
            },
            aead: flora_messaging_contracts::AeadParamsDto {
                name: r.aead_name,
                nonce_base64_url: r.aead_nonce_base64url,
            },
            ciphertext_base64_url: r.ciphertext_base64url,
        }
    }
}

fn format_utc(dt: DateTime<Utc>) -> String {
    use chrono::SecondsFormat;
    dt.to_rfc3339_opts(SecondsFormat::Millis, true)
}

impl From<RecoveryMetaDbRow> for RecoveryBackupMetaDto {
    fn from(r: RecoveryMetaDbRow) -> Self {
        Self {
            recovery_key_id: r.recovery_key_id,
            recovery_revision: r.recovery_revision,
            primary_key_epoch_id: r.primary_key_epoch_id,
            epoch_set_revision: r.epoch_set_revision,
            epoch_set_hash_base64_url: r.epoch_set_hash_base64url,
            wordlist: flora_messaging_contracts::WordlistInfoDto {
                id: r.wordlist_id,
                words_count: r.words_count,
            },
            created_at: format_utc(r.created_at),
            updated_at: format_utc(r.updated_at),
            used_at: r.used_at.map(format_utc),
        }
    }
}

impl From<RecoveryBackupDbRow> for RecoveryBackupPayloadDto {
    fn from(r: RecoveryBackupDbRow) -> Self {
        Self {
            version: r.version,
            recovery_revision: r.recovery_revision,
            recovery_key_id: r.recovery_key_id,
            user_uuid: r.user_uuid,
            primary_key_epoch_id: r.primary_key_epoch_id,
            epoch_set_revision: r.epoch_set_revision,
            epoch_set_hash_base64_url: r.epoch_set_hash_base64url,
            wordlist: flora_messaging_contracts::WordlistInfoDto {
                id: r.wordlist_id,
                words_count: r.words_count,
            },
            kdf: flora_messaging_contracts::KdfParamsDto {
                name: r.kdf_name,
                memory_ki_b: r.kdf_memory_kib,
                iterations: r.kdf_iterations,
                parallelism: r.kdf_parallelism,
                salt_base64_url: r.kdf_salt_base64url,
            },
            aead: flora_messaging_contracts::AeadParamsDto {
                name: r.aead_name,
                nonce_base64_url: r.aead_nonce_base64url,
            },
            ciphertext_base64_url: r.ciphertext_base64url,
        }
    }
}
