//! E2E FSM state, key/recovery backups, epochs, unlock, devices (opaque ciphertext).

use axum::Json;
use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use flora_messaging_contracts::{
    AddPendingDeviceRequestDto, CreateEpochRequestDto, PutKeyBackupRequestDto,
    RecoveryBackupPayloadDto, SetE2ePublicKeyRequestDto, UnlockCompleteRequestDto,
};

use crate::application::{
    AddPendingDeviceError, CreateEpochError, GetE2ePublicKeyError, PutKeyBackupError,
    PutRecoveryBackupError, RevokeDeviceError, SetE2ePublicKeyError, UnlockChallengeError,
    UnlockCompleteError,
};
use crate::http::{CurrentUser, MessagingState};

pub async fn get_e2e_state(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    match state.e2e.get_state(user.0).await {
        Ok(dto) => Json(dto).into_response(),
        Err(e) => crate::http::internal(e),
    }
}

pub async fn get_key_backup(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    match state.e2e.get_key_backup(user.0).await {
        Ok(Some(dto)) => Json(dto).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Key backup not found." })),
        )
            .into_response(),
        Err(e) => crate::http::internal(e),
    }
}

pub async fn put_key_backup(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<PutKeyBackupRequestDto>,
) -> Response {
    match state.e2e.put_key_backup(user.0, body).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(PutKeyBackupError::AccountLocked) => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "PUT key-backup is not allowed while account state is locked.",
                "code": "messaging.e2e.key_backup.account_locked"
            })),
        )
            .into_response(),
        Err(PutKeyBackupError::AccountFrozen) => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "Account is frozen.",
                "code": "messaging.e2e.key_backup.account_frozen"
            })),
        )
            .into_response(),
        Err(PutKeyBackupError::Forbidden) => StatusCode::FORBIDDEN.into_response(),
        Err(PutKeyBackupError::Conflict(msg)) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(PutKeyBackupError::Internal(e)) => crate::http::internal(e),
    }
}

pub async fn get_recovery_backups(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    match state.e2e.get_recovery_backups(user.0).await {
        Ok(list) => Json(list).into_response(),
        Err(e) => crate::http::internal(e),
    }
}

pub async fn get_recovery_backup(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(recovery_key_id): Path<uuid::Uuid>,
) -> Response {
    match state.e2e.get_recovery_backup(user.0, recovery_key_id).await {
        Ok(Some(dto)) => Json(dto).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Recovery backup not found." })),
        )
            .into_response(),
        Err(e) => crate::http::internal(e),
    }
}

pub async fn put_recovery_backup(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<RecoveryBackupPayloadDto>,
) -> Response {
    match state.e2e.put_recovery_backup(user.0, body).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(PutRecoveryBackupError::Forbidden) => StatusCode::FORBIDDEN.into_response(),
        Err(PutRecoveryBackupError::Internal(e)) => crate::http::internal(e),
    }
}

pub async fn lock_e2e(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    match state.e2e.lock(user.0).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => crate::http::internal(e),
    }
}

pub async fn create_epoch(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<CreateEpochRequestDto>,
) -> Response {
    match state.epochs.create_epoch(user.0, body).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(CreateEpochError::AccountNotInRequiredState(msg)) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "code": "messaging.e2e.epochs.not_allowed_in_current_account_state",
                "error": msg
            })),
        )
            .into_response(),
        Err(CreateEpochError::IdempotencyConflict(msg)) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "code": "messaging.e2e.epochs.idempotency_conflict",
                "error": msg
            })),
        )
            .into_response(),
        Err(CreateEpochError::Conflict(msg)) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(CreateEpochError::Internal(e)) => crate::http::internal(e),
    }
}

pub async fn request_unlock_challenge(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    match state.epochs.request_unlock_challenge(user.0).await {
        Ok(dto) => Json(dto).into_response(),
        Err(UnlockChallengeError::AccountNotInRequiredState(msg)) => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(UnlockChallengeError::Internal(e)) => crate::http::internal(e),
    }
}

pub async fn unlock_complete(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<UnlockCompleteRequestDto>,
) -> Response {
    match state.epochs.unlock_complete(user.0, body).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(UnlockCompleteError::RecoveredEpochsEmpty) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "code": "messaging.e2e.unlock_complete.recovered_epochs_empty",
                "error": "recoveredKeyEpochIds must contain at least one epoch ID. (messaging.e2e.unlock_complete.recovered_epochs_empty)"
            })),
        )
            .into_response(),
        Err(UnlockCompleteError::SignatureInvalid(msg)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "code": "messaging.e2e.unlock_complete.signature_invalid",
                "error": msg
            })),
        )
            .into_response(),
        Err(UnlockCompleteError::ChallengeExpiredOrUsed(msg)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "code": "messaging.e2e.unlock_complete.challenge_expired_or_used",
                "error": msg
            })),
        )
            .into_response(),
        Err(UnlockCompleteError::IdempotencyConflict(msg)) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "code": "messaging.e2e.unlock_complete.idempotency_conflict",
                "error": msg
            })),
        )
            .into_response(),
        Err(UnlockCompleteError::AccountNotInRequiredState(msg)) => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(UnlockCompleteError::EpochSetHashUnchanged) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "code": "messaging.e2e.unlock_complete.epoch_set_hash_unchanged",
                "error": "epochSetHashBase64Url must differ from the previously stored hash in a successful unlock-complete."
            })),
        )
            .into_response(),
        Err(UnlockCompleteError::Conflict(msg)) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(UnlockCompleteError::Forbidden(msg)) => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(UnlockCompleteError::Internal(e)) => crate::http::internal(e),
    }
}

pub async fn add_pending_device(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(key_epoch_id): Path<uuid::Uuid>,
    Json(body): Json<AddPendingDeviceRequestDto>,
) -> Response {
    match state.epochs.add_pending_device(user.0, key_epoch_id, body).await {
        Ok(dto) => Json(dto).into_response(),
        Err(AddPendingDeviceError::AccountNotInRequiredState(msg)) => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(AddPendingDeviceError::NotFound(msg)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(AddPendingDeviceError::Internal(e)) => crate::http::internal(e),
    }
}

pub async fn get_devices(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(key_epoch_id): Path<uuid::Uuid>,
) -> Response {
    match state.epochs.get_devices(user.0, key_epoch_id).await {
        Ok(list) => Json(list).into_response(),
        Err(e) => crate::http::internal(e),
    }
}

pub async fn revoke_device(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path((key_epoch_id, device_uuid)): Path<(uuid::Uuid, uuid::Uuid)>,
) -> Response {
    match state
        .epochs
        .revoke_device(user.0, key_epoch_id, device_uuid)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(RevokeDeviceError::NotFound(msg)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(RevokeDeviceError::Internal(e)) => crate::http::internal(e),
    }
}

/// PUT/POST `/api/auth/me/e2e-public-key` — legacy ImportedSocialController parity.
pub async fn set_my_e2e_public_key(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    body: Option<Json<SetE2ePublicKeyRequestDto>>,
) -> Response {
    let request = body.map(|Json(b)| b).unwrap_or_default();
    match state.e2e.set_my_public_key(user.0, request).await {
        Ok(dto) => Json(dto).into_response(),
        Err(SetE2ePublicKeyError::BadRequest(error)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": error })),
        )
            .into_response(),
        Err(SetE2ePublicKeyError::Internal { detail }) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": "Ошибка сохранения ключа.",
                "detail": detail
            })),
        )
            .into_response(),
    }
}

/// GET `/api/auth/users/{user_uuid}/e2e-public-key`.
pub async fn get_user_e2e_public_key(
    State(state): State<MessagingState>,
    Path(user_uuid): Path<uuid::Uuid>,
) -> Response {
    match state.e2e.get_user_public_key(user_uuid).await {
        Ok(dto) => Json(dto).into_response(),
        Err(GetE2ePublicKeyError::NotFound) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": "Публичный ключ пользователя не найден. Возможно, он ещё не открывал сообщения в этом браузере."
            })),
        )
            .into_response(),
        Err(GetE2ePublicKeyError::Internal { detail }) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": "Ошибка получения ключа.",
                "detail": detail
            })),
        )
            .into_response(),
    }
}
