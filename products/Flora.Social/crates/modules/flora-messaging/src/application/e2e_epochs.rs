//! E2E epochs, unlock-complete, device keys.

use std::sync::Arc;

use chrono::SecondsFormat;
use flora_messaging_contracts::{
    AddPendingDeviceRequestDto, AddPendingDeviceResponseDto, ApproveDeviceRequestDto,
    ApproveDeviceResponseDto, CreateEpochRequestDto, DeviceKeyEntryDto,
    DeviceRecoveryEnvelopeResponseDto, PostDeviceRecoveryEnvelopeRequestDto,
    PostDeviceRecoveryEnvelopeResponseDto, UnlockChallengeResponseDto, UnlockCompleteRequestDto,
};
use sqlx::PgPool;
use uuid::Uuid;

use crate::infrastructure::{
    DeviceBindingRow, E2eEpochRepoError, E2eProofTokens, add_pending_device, approve_device,
    create_epoch, fetch_device_binding, fetch_devices, fetch_recovery_envelope,
    request_unlock_challenge, revoke_device, store_recovery_envelope, unlock_complete,
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
    ProofTokenInvalid(String),
    Internal(String),
}

#[derive(Debug, Clone)]
pub enum ApproveDeviceError {
    AccountNotInRequiredState(String),
    SignatureInvalid(String),
    Forbidden(String),
    NotFound(String),
    Conflict(String),
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

/// Ошибки POST/GET .../devices/{deviceUuid}/recover-key (e2e-security.md §Devices).
#[derive(Debug, Clone)]
pub enum RecoverKeyError {
    AccountNotInRequiredState(String),
    /// Конверт не прошёл структурную валидацию или binding (400).
    EnvelopeInvalid(String),
    /// Ed25519-подпись source-устройства не сходится (400).
    SignatureInvalid(String),
    Forbidden(String),
    NotFound(String),
    Conflict(String),
    Internal(String),
}

pub struct E2eEpochService {
    pool: PgPool,
    tokens: Arc<E2eProofTokens>,
}

impl E2eEpochService {
    pub fn new(pool: PgPool, tokens: Arc<E2eProofTokens>) -> Self {
        Self { pool, tokens }
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
        unlock_complete(&self.pool, &self.tokens, user_uuid, &request)
            .await
            .map_err(map_unlock_complete_error)
    }

    /// Approve pending-устройства подписью active-устройства той же epoch;
    /// при успехе выдаёт `trustedDeviceApprovalToken` для `unlock-complete`.
    pub async fn approve_device(
        &self,
        user_uuid: Uuid,
        key_epoch_id: Uuid,
        device_uuid: Uuid,
        request: ApproveDeviceRequestDto,
    ) -> Result<ApproveDeviceResponseDto, ApproveDeviceError> {
        approve_device(
            &self.pool,
            user_uuid,
            key_epoch_id,
            device_uuid,
            request.approving_device_uuid,
            &request.approval_signature_base64_url,
        )
        .await
        .map_err(|e| match e {
            E2eEpochRepoError::AccountNotInRequiredState(msg) => {
                ApproveDeviceError::AccountNotInRequiredState(msg)
            }
            E2eEpochRepoError::SignatureInvalid(msg) => ApproveDeviceError::SignatureInvalid(msg),
            E2eEpochRepoError::Forbidden(msg) => ApproveDeviceError::Forbidden(msg),
            E2eEpochRepoError::NotFound(msg) => ApproveDeviceError::NotFound(msg),
            E2eEpochRepoError::Conflict(msg) => ApproveDeviceError::Conflict(msg),
            E2eEpochRepoError::Internal(msg) => ApproveDeviceError::Internal(msg),
            other => ApproveDeviceError::Internal(other.to_string()),
        })?;

        let token = self.tokens.issue_device_approval(
            user_uuid,
            key_epoch_id,
            device_uuid,
            request.approving_device_uuid,
        );
        Ok(ApproveDeviceResponseDto {
            device_uuid,
            trusted_device_approval_token: token.as_ref().map(|(t, _)| t.clone()),
            trusted_device_approval_token_expires_at: token
                .as_ref()
                .map(|(_, exp)| exp.to_rfc3339_opts(SecondsFormat::Millis, true)),
        })
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

    /// POST .../epochs/{keyEpochId}/devices/{deviceUuid}/recover-key — серверный
    /// транспорт DeviceToDeviceRecoveryEnvelope (e2e-security.md §Devices).
    ///
    /// Инварианты: сервер не расшифровывает ciphertext; проверяются форма конверта
    /// (fscp-core, strict), binding user/target/path-scope, Ed25519-подпись против
    /// **сохранённого** signing key source-устройства и authority source-устройства
    /// (active binding в path epoch и в каждой epoch из `transferredKeyEpochIds`).
    pub async fn post_recovery_envelope(
        &self,
        user_uuid: Uuid,
        key_epoch_id: Uuid,
        target_device_uuid: Uuid,
        request: PostDeviceRecoveryEnvelopeRequestDto,
    ) -> Result<PostDeviceRecoveryEnvelopeResponseDto, RecoverKeyError> {
        self.ensure_recover_key_state(user_uuid).await?;

        let summary = fscp_core::try_validate_d2d_recovery_envelope(&request.envelope)
            .map_err(RecoverKeyError::EnvelopeInvalid)?;

        if summary.user_uuid != user_uuid {
            return Err(RecoverKeyError::Forbidden(
                "Конверт привязан к другому пользователю.".into(),
            ));
        }
        if summary.target_device_uuid != target_device_uuid {
            return Err(RecoverKeyError::EnvelopeInvalid(
                "targetDeviceUuid конверта не совпадает с устройством в path.".into(),
            ));
        }

        self.ensure_recovery_target_binding(user_uuid, key_epoch_id, target_device_uuid)
            .await?;
        let source = self
            .ensure_active_recovery_source(
                user_uuid,
                key_epoch_id,
                summary.source_device_uuid,
                &summary.transferred_key_epoch_ids,
            )
            .await?;

        fscp_core::verify_d2d_recovery_signature(
            &request.envelope,
            &source.signing_public_key_base64url,
        )
        .map_err(RecoverKeyError::SignatureInvalid)?;

        let expires_at = store_recovery_envelope(
            &self.pool,
            user_uuid,
            key_epoch_id,
            target_device_uuid,
            summary.source_device_uuid,
            summary.recovery_request_id,
            &summary.transferred_key_epoch_ids,
            &summary.canonical_json,
        )
        .await
        .map_err(map_recover_key_repo_error)?;

        Ok(PostDeviceRecoveryEnvelopeResponseDto {
            recovery_request_id: summary.recovery_request_id,
            expires_at: expires_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        })
    }

    /// GET .../epochs/{keyEpochId}/devices/{deviceUuid}/recover-key — target-устройство
    /// забирает сохранённый конверт (расшифровать его может только оно).
    pub async fn get_recovery_envelope(
        &self,
        user_uuid: Uuid,
        key_epoch_id: Uuid,
        target_device_uuid: Uuid,
    ) -> Result<DeviceRecoveryEnvelopeResponseDto, RecoverKeyError> {
        self.ensure_recover_key_state(user_uuid).await?;
        self.ensure_recovery_target_binding(user_uuid, key_epoch_id, target_device_uuid)
            .await?;

        let stored =
            fetch_recovery_envelope(&self.pool, user_uuid, key_epoch_id, target_device_uuid)
                .await
                .map_err(map_recover_key_repo_error)?
                .ok_or_else(|| {
                    RecoverKeyError::NotFound("Recovery envelope not found or expired.".into())
                })?;

        // Повторная authority-проверка на выдаче закрывает окно POST → revoke → GET:
        // конверт от/для уже отозванного устройства не должен покидать хранилище.
        self.ensure_active_recovery_source(
            user_uuid,
            key_epoch_id,
            stored.source_device_uuid,
            &stored.transferred_key_epoch_ids,
        )
        .await?;

        let envelope: serde_json::Value = serde_json::from_str(&stored.envelope_canonical_json)
            .map_err(|e| RecoverKeyError::Internal(e.to_string()))?;

        Ok(DeviceRecoveryEnvelopeResponseDto {
            envelope,
            source_device_uuid: stored.source_device_uuid,
            recovery_request_id: stored.recovery_request_id,
            created_at: stored
                .created_at
                .to_rfc3339_opts(SecondsFormat::Millis, true),
            expires_at: stored
                .expires_at
                .to_rfc3339_opts(SecondsFormat::Millis, true),
        })
    }

    async fn ensure_recovery_target_binding(
        &self,
        user_uuid: Uuid,
        key_epoch_id: Uuid,
        target_device_uuid: Uuid,
    ) -> Result<DeviceBindingRow, RecoverKeyError> {
        let target = fetch_device_binding(&self.pool, user_uuid, key_epoch_id, target_device_uuid)
            .await
            .map_err(map_recover_key_repo_error)?
            .ok_or_else(|| {
                RecoverKeyError::NotFound(format!(
                    "Device {target_device_uuid} not found for epoch {key_epoch_id}."
                ))
            })?;
        if !matches!(target.status.as_str(), "Pending" | "Active") {
            return Err(RecoverKeyError::Conflict(
                "Only pending or active devices can receive a recovery envelope.".into(),
            ));
        }
        Ok(target)
    }

    async fn ensure_active_recovery_source(
        &self,
        user_uuid: Uuid,
        key_epoch_id: Uuid,
        source_device_uuid: Uuid,
        transferred_key_epoch_ids: &[Uuid],
    ) -> Result<DeviceBindingRow, RecoverKeyError> {
        let source = fetch_device_binding(&self.pool, user_uuid, key_epoch_id, source_device_uuid)
            .await
            .map_err(map_recover_key_repo_error)?
            .ok_or_else(|| {
                RecoverKeyError::NotFound(format!(
                    "Source device {source_device_uuid} not found for epoch {key_epoch_id}."
                ))
            })?;
        if source.status != "Active" {
            return Err(RecoverKeyError::Forbidden(
                "Source device must be active in this key epoch.".into(),
            ));
        }

        // Authority: active binding source-устройства в каждой передаваемой epoch
        // (иначе устройство новой epoch могло бы "подтверждать" старую locked epoch).
        for epoch_id in transferred_key_epoch_ids {
            if *epoch_id == key_epoch_id {
                continue;
            }
            let binding =
                fetch_device_binding(&self.pool, user_uuid, *epoch_id, source_device_uuid)
                    .await
                    .map_err(map_recover_key_repo_error)?;
            if binding.as_ref().map(|b| b.status.as_str()) != Some("Active") {
                return Err(RecoverKeyError::Forbidden(format!(
                    "Source device has no active binding for transferred epoch {epoch_id}."
                )));
            }
        }
        Ok(source)
    }

    /// FSM-состояния, в которых разрешён recover-key, — как у approve
    /// (active / active_new_epoch / recovering); frozen и locked отклоняются.
    async fn ensure_recover_key_state(&self, user_uuid: Uuid) -> Result<(), RecoverKeyError> {
        let state = crate::infrastructure::fetch_account_state(&self.pool, user_uuid)
            .await
            .map_err(RecoverKeyError::Internal)?;
        let allowed = matches!(
            state.as_ref().map(|s| s.state.as_str()),
            Some("Active") | Some("ActiveNewEpoch") | Some("Recovering")
        );
        if !allowed {
            return Err(RecoverKeyError::AccountNotInRequiredState(
                "recover-key is only allowed when account state = active, active_new_epoch or recovering."
                    .into(),
            ));
        }
        Ok(())
    }
}

fn map_recover_key_repo_error(e: E2eEpochRepoError) -> RecoverKeyError {
    match e {
        E2eEpochRepoError::NotFound(msg) => RecoverKeyError::NotFound(msg),
        E2eEpochRepoError::Conflict(msg) => RecoverKeyError::Conflict(msg),
        E2eEpochRepoError::Forbidden(msg) => RecoverKeyError::Forbidden(msg),
        E2eEpochRepoError::Internal(msg) => RecoverKeyError::Internal(msg),
        other => RecoverKeyError::Internal(other.to_string()),
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
        E2eEpochRepoError::IdempotencyConflict(msg) => {
            UnlockCompleteError::IdempotencyConflict(msg)
        }
        E2eEpochRepoError::AccountNotInRequiredState(msg) => {
            UnlockCompleteError::AccountNotInRequiredState(msg)
        }
        E2eEpochRepoError::EpochSetHashUnchanged => UnlockCompleteError::EpochSetHashUnchanged,
        E2eEpochRepoError::Conflict(msg) => UnlockCompleteError::Conflict(msg),
        E2eEpochRepoError::Forbidden(msg) => UnlockCompleteError::Forbidden(msg),
        E2eEpochRepoError::ProofTokenInvalid(msg) => UnlockCompleteError::ProofTokenInvalid(msg),
        E2eEpochRepoError::Internal(msg) => UnlockCompleteError::Internal(msg),
        other => UnlockCompleteError::Internal(other.to_string()),
    }
}

impl std::fmt::Display for E2eEpochRepoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
