//! E2E epochs, unlock-complete, device keys.

use flora_messaging_contracts::{
    AddPendingDeviceRequestDto, AddPendingDeviceResponseDto, CreateEpochRequestDto,
    DeviceKeyEntryDto, UnlockChallengeResponseDto, UnlockCompleteRequestDto,
};
use sqlx::PgPool;
use uuid::Uuid;

use crate::infrastructure::{
    E2eEpochRepoError, add_pending_device, create_epoch, fetch_devices, request_unlock_challenge,
    revoke_device, unlock_complete,
};

#[derive(Debug, Clone)]
pub enum CreateEpochError {
    AccountNotInRequiredState(String),
    IdempotencyConflict(String),
    Conflict(String),
    Internal(String),
}

#[derive(Debug, Clone)]
pub enum UnlockChallengeError {
    AccountNotInRequiredState(String),
    Internal(String),
}

#[derive(Debug, Clone)]
pub enum UnlockCompleteError {
    RecoveredEpochsEmpty,
    SignatureInvalid(String),
    ChallengeExpiredOrUsed(String),
    IdempotencyConflict(String),
    AccountNotInRequiredState(String),
    EpochSetHashUnchanged,
    Conflict(String),
    Forbidden(String),
    Internal(String),
}

#[derive(Debug, Clone)]
pub enum AddPendingDeviceError {
    AccountNotInRequiredState(String),
    NotFound(String),
    Internal(String),
}

#[derive(Debug, Clone)]
pub enum RevokeDeviceError {
    NotFound(String),
    Internal(String),
}

pub struct E2eEpochService {
    pool: PgPool,
}

impl E2eEpochService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn create_epoch(
        &self,
        user_uuid: Uuid,
        request: CreateEpochRequestDto,
    ) -> Result<(), CreateEpochError> {
        create_epoch(&self.pool, user_uuid, &request)
            .await
            .map_err(map_create_epoch_error)
    }

    pub async fn request_unlock_challenge(
        &self,
        user_uuid: Uuid,
    ) -> Result<UnlockChallengeResponseDto, UnlockChallengeError> {
        request_unlock_challenge(&self.pool, user_uuid)
            .await
            .map_err(|e| match e {
                E2eEpochRepoError::AccountNotInRequiredState(msg) => {
                    UnlockChallengeError::AccountNotInRequiredState(msg)
                }
                E2eEpochRepoError::Internal(msg) => UnlockChallengeError::Internal(msg),
                other => UnlockChallengeError::Internal(other.to_string()),
            })
    }

    pub async fn unlock_complete(
        &self,
        user_uuid: Uuid,
        request: UnlockCompleteRequestDto,
    ) -> Result<(), UnlockCompleteError> {
        unlock_complete(&self.pool, user_uuid, &request)
            .await
            .map_err(map_unlock_complete_error)
    }

    pub async fn add_pending_device(
        &self,
        user_uuid: Uuid,
        key_epoch_id: Uuid,
        request: AddPendingDeviceRequestDto,
    ) -> Result<AddPendingDeviceResponseDto, AddPendingDeviceError> {
        let device_uuid = add_pending_device(&self.pool, user_uuid, key_epoch_id, &request)
            .await
            .map_err(|e| match e {
                E2eEpochRepoError::AccountNotInRequiredState(msg) => {
                    AddPendingDeviceError::AccountNotInRequiredState(msg)
                }
                E2eEpochRepoError::NotFound(msg) => AddPendingDeviceError::NotFound(msg),
                E2eEpochRepoError::Internal(msg) => AddPendingDeviceError::Internal(msg),
                other => AddPendingDeviceError::Internal(other.to_string()),
            })?;
        Ok(AddPendingDeviceResponseDto { device_uuid })
    }

    pub async fn get_devices(
        &self,
        user_uuid: Uuid,
        key_epoch_id: Uuid,
    ) -> Result<Vec<DeviceKeyEntryDto>, String> {
        fetch_devices(&self.pool, user_uuid, key_epoch_id).await
    }

    pub async fn revoke_device(
        &self,
        user_uuid: Uuid,
        key_epoch_id: Uuid,
        device_uuid: Uuid,
    ) -> Result<(), RevokeDeviceError> {
        revoke_device(&self.pool, user_uuid, key_epoch_id, device_uuid)
            .await
            .map_err(|e| match e {
                E2eEpochRepoError::NotFound(msg) => RevokeDeviceError::NotFound(msg),
                E2eEpochRepoError::Internal(msg) => RevokeDeviceError::Internal(msg),
                other => RevokeDeviceError::Internal(other.to_string()),
            })
    }
}

fn map_create_epoch_error(e: E2eEpochRepoError) -> CreateEpochError {
    match e {
        E2eEpochRepoError::AccountNotInRequiredState(msg) => {
            CreateEpochError::AccountNotInRequiredState(msg)
        }
        E2eEpochRepoError::IdempotencyConflict(msg) => CreateEpochError::IdempotencyConflict(msg),
        E2eEpochRepoError::Conflict(msg) => CreateEpochError::Conflict(msg),
        E2eEpochRepoError::Internal(msg) => CreateEpochError::Internal(msg),
        other => CreateEpochError::Internal(other.to_string()),
    }
}

fn map_unlock_complete_error(e: E2eEpochRepoError) -> UnlockCompleteError {
    match e {
        E2eEpochRepoError::RecoveredEpochsEmpty => UnlockCompleteError::RecoveredEpochsEmpty,
        E2eEpochRepoError::SignatureInvalid(msg) => UnlockCompleteError::SignatureInvalid(msg),
        E2eEpochRepoError::ChallengeExpiredOrUsed(msg) => {
            UnlockCompleteError::ChallengeExpiredOrUsed(msg)
        }
        E2eEpochRepoError::IdempotencyConflict(msg) => UnlockCompleteError::IdempotencyConflict(msg),
        E2eEpochRepoError::AccountNotInRequiredState(msg) => {
            UnlockCompleteError::AccountNotInRequiredState(msg)
        }
        E2eEpochRepoError::EpochSetHashUnchanged => UnlockCompleteError::EpochSetHashUnchanged,
        E2eEpochRepoError::Conflict(msg) => UnlockCompleteError::Conflict(msg),
        E2eEpochRepoError::Forbidden(msg) => UnlockCompleteError::Forbidden(msg),
        E2eEpochRepoError::Internal(msg) => UnlockCompleteError::Internal(msg),
        other => UnlockCompleteError::Internal(other.to_string()),
    }
}

impl std::fmt::Display for E2eEpochRepoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
