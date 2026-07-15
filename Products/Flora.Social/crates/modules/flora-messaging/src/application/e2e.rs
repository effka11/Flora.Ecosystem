//! E2E account state + password key backup (opaque store) + legacy public keys.

use chrono::{DateTime, SecondsFormat, Utc};
use flora_messaging_contracts::{
    E2eStateResponseDto, KeyBackupPayloadDto, PutKeyBackupRequestDto, RecoveryBackupMetaDto,
    RecoveryBackupPayloadDto, SetE2ePublicKeyRequestDto, SetE2ePublicKeyResponseDto,
    UserE2ePublicKeyDto,
};
use sqlx::PgPool;
use uuid::Uuid;

use crate::infrastructure::{
    PutKeyBackupRepoError, fetch_account_state, fetch_key_backup, fetch_recovery_backup,
    fetch_recovery_backups, fetch_user_e2e_key, fetch_user_e2e_keys_by_uuids, insert_user_e2e_key,
    lock_account, put_key_backup, put_recovery_backup, update_user_e2e_key,
};

#[derive(Debug, Clone)]
pub enum PutKeyBackupError {
    Forbidden,
    AccountLocked,
    AccountFrozen,
    Conflict(String),
    Internal(String),
}

#[derive(Debug, Clone)]
pub enum SetE2ePublicKeyError {
    BadRequest(String),
    Internal { detail: String },
}

#[derive(Debug, Clone)]
pub enum GetE2ePublicKeyError {
    NotFound,
    Internal { detail: String },
}

pub struct E2eKeyBackupService {
    pool: PgPool,
}

impl E2eKeyBackupService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn get_state(&self, user_uuid: Uuid) -> Result<E2eStateResponseDto, String> {
        match fetch_account_state(&self.pool, user_uuid).await? {
            Some(row) => Ok(E2eStateResponseDto {
                state: db_state_to_api(&row.state),
                freeze: row.freeze,
                updated_at: format_utc(row.updated_at),
            }),
            None => Ok(E2eStateResponseDto {
                state: "not_initialized".into(),
                freeze: false,
                updated_at: format_utc(Utc::now()),
            }),
        }
    }

    pub async fn get_key_backup(
        &self,
        user_uuid: Uuid,
    ) -> Result<Option<KeyBackupPayloadDto>, String> {
        fetch_key_backup(&self.pool, user_uuid).await
    }

    pub async fn put_key_backup(
        &self,
        user_uuid: Uuid,
        request: PutKeyBackupRequestDto,
    ) -> Result<(), PutKeyBackupError> {
        if request.key_backup.user_uuid != user_uuid {
            return Err(PutKeyBackupError::Forbidden);
        }
        put_key_backup(&self.pool, user_uuid, &request)
            .await
            .map_err(|e| match e {
                PutKeyBackupRepoError::AccountLocked => PutKeyBackupError::AccountLocked,
                PutKeyBackupRepoError::AccountFrozen => PutKeyBackupError::AccountFrozen,
                PutKeyBackupRepoError::Forbidden => PutKeyBackupError::Forbidden,
                PutKeyBackupRepoError::Conflict(msg) => PutKeyBackupError::Conflict(msg),
                PutKeyBackupRepoError::Internal(msg) => PutKeyBackupError::Internal(msg),
            })
    }

    pub async fn get_recovery_backups(
        &self,
        user_uuid: Uuid,
    ) -> Result<Vec<RecoveryBackupMetaDto>, String> {
        fetch_recovery_backups(&self.pool, user_uuid).await
    }

    pub async fn get_recovery_backup(
        &self,
        user_uuid: Uuid,
        recovery_key_id: Uuid,
    ) -> Result<Option<RecoveryBackupPayloadDto>, String> {
        fetch_recovery_backup(&self.pool, user_uuid, recovery_key_id).await
    }

    pub async fn put_recovery_backup(
        &self,
        user_uuid: Uuid,
        payload: RecoveryBackupPayloadDto,
    ) -> Result<(), PutRecoveryBackupError> {
        if payload.user_uuid != user_uuid {
            return Err(PutRecoveryBackupError::Forbidden);
        }
        put_recovery_backup(&self.pool, user_uuid, &payload)
            .await
            .map_err(PutRecoveryBackupError::Internal)
    }

    pub async fn lock(&self, user_uuid: Uuid) -> Result<(), String> {
        lock_account(&self.pool, user_uuid).await
    }

    /// PUT/POST `/api/auth/me/e2e-public-key` — C# `SetMyE2EPublicKey` 1:1.
    pub async fn set_my_public_key(
        &self,
        user_uuid: Uuid,
        request: SetE2ePublicKeyRequestDto,
    ) -> Result<SetE2ePublicKeyResponseDto, SetE2ePublicKeyError> {
        let public_key_base64 = request
            .public_key_base64
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string();
        if public_key_base64.is_empty() || public_key_base64.len() > 2000 {
            return Err(SetE2ePublicKeyError::BadRequest(
                "Некорректный публичный ключ. Отправьте JSON: { \"publicKeyBase64\": \"...\", \"deviceUuid\": \"...\" }."
                    .into(),
            ));
        }

        let requested_device = request
            .device_uuid
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .and_then(|s| Uuid::parse_str(s).ok());

        match fetch_user_e2e_key(&self.pool, user_uuid).await {
            Ok(None) => {
                let device_uuid = requested_device.unwrap_or_else(Uuid::now_v7);
                let now = Utc::now();
                insert_user_e2e_key(&self.pool, user_uuid, &public_key_base64, device_uuid, now)
                    .await
                    .map_err(|detail| SetE2ePublicKeyError::Internal { detail })?;
                Ok(SetE2ePublicKeyResponseDto {
                    message: "Ключ сохранён.".into(),
                    device_uuid: Some(device_uuid),
                })
            }
            Ok(Some(existing)) => {
                let device_uuid = if let Some(d) = requested_device {
                    Some(d)
                } else if existing.device_uuid.is_none() {
                    Some(Uuid::now_v7())
                } else {
                    existing.device_uuid
                };
                let now = Utc::now();
                update_user_e2e_key(&self.pool, user_uuid, &public_key_base64, device_uuid, now)
                    .await
                    .map_err(|detail| SetE2ePublicKeyError::Internal { detail })?;
                Ok(SetE2ePublicKeyResponseDto {
                    message: "Ключ сохранён.".into(),
                    device_uuid,
                })
            }
            Err(detail) => Err(SetE2ePublicKeyError::Internal { detail }),
        }
    }

    /// GET `/api/auth/users/{userUuid}/e2e-public-key` — C# `GetUserE2EPublicKey` 1:1.
    pub async fn get_user_public_key(
        &self,
        user_uuid: Uuid,
    ) -> Result<UserE2ePublicKeyDto, GetE2ePublicKeyError> {
        match fetch_user_e2e_key(&self.pool, user_uuid).await {
            Ok(Some(row)) => Ok(UserE2ePublicKeyDto {
                public_key_base64: row.public_key_base64,
                device_uuid: row.device_uuid,
            }),
            Ok(None) => Err(GetE2ePublicKeyError::NotFound),
            Err(detail) => Err(GetE2ePublicKeyError::Internal { detail }),
        }
    }

    /// Batch for legacy conversation list. Errors → empty map (C# try/catch → empty dict).
    pub async fn public_keys_by_uuids(
        &self,
        user_uuids: &[Uuid],
    ) -> std::collections::HashMap<Uuid, String> {
        match fetch_user_e2e_keys_by_uuids(&self.pool, user_uuids).await {
            Ok(rows) => rows.into_iter().collect(),
            Err(e) => {
                tracing::warn!(error = %e, "legacy e2e public keys batch failed");
                std::collections::HashMap::new()
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PutRecoveryBackupError {
    Forbidden,
    Internal(String),
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
