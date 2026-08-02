//! Контракты модуля Messaging — DTO и trait-порты без бизнес-логики (next-architecture.md §2.2).
//!
//! Публичные порты для Notifications (`MessageSentNotifier` / C# `IMessageSentNotifier`).
//! Чужим модулям разрешена зависимость только от этого crate (§2.3).

use std::future::Future;
use std::pin::Pin;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedPushPreview {
    pub installation_uuid: Uuid,
    pub preview_key_id: Uuid,
    pub envelope: String,
}

#[derive(Debug, Clone)]
pub struct MessageSentContext {
    pub recipient_user_uuid: Uuid,
    pub sender_user_uuid: Uuid,
    pub persisted_message_uuid: Uuid,
    pub wire_message_uuid: Uuid,
    pub encrypted_push_previews: Vec<EncryptedPushPreview>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushPreviewTarget {
    pub installation_uuid: Uuid,
    pub preview_key_id: Uuid,
    pub public_key_base64_url: String,
    pub protocol_version: i32,
}

pub trait PushPreviewTargetProvider: Send + Sync {
    fn targets_for(
        &self,
        recipient_user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<Vec<PushPreviewTarget>, String>>;
}

pub struct NoopPushPreviewTargetProvider;

impl PushPreviewTargetProvider for NoopPushPreviewTargetProvider {
    fn targets_for(
        &self,
        _recipient_user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<Vec<PushPreviewTarget>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

/// Cross-module port: notify recipient after a DM is persisted (SSE hub + push).
/// Implemented by Notifications; Messaging must not reference Notifications internals.
///
/// Только bounded opaque ciphertext может пересекать границу. Plaintext preview
/// и полный message wire в порт не передаются.
pub trait MessageSentNotifier: Send + Sync {
    fn notify(&self, context: MessageSentContext) -> BoxFuture<'_, ()>;
}

/// No-op when Notifications ServeNative is off (SSE remains absent).
pub struct NoopMessageSentNotifier;

impl MessageSentNotifier for NoopMessageSentNotifier {
    fn notify(&self, _context: MessageSentContext) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
}

/// Cross-module port: typing indicator SSE to DM peer (no FCM).
pub trait MessageTypingNotifier: Send + Sync {
    fn notify_typing(
        &self,
        recipient_user_uuid: Uuid,
        conversation_uuid: Uuid,
        sender_user_uuid: Uuid,
        is_typing: bool,
    ) -> BoxFuture<'_, ()>;
}

pub struct NoopMessageTypingNotifier;

impl MessageTypingNotifier for NoopMessageTypingNotifier {
    fn notify_typing(
        &self,
        _recipient_user_uuid: Uuid,
        _conversation_uuid: Uuid,
        _sender_user_uuid: Uuid,
        _is_typing: bool,
    ) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
}

/// Cross-module port: read-receipt SSE to DM peer (no FCM).
pub trait MessageReadNotifier: Send + Sync {
    fn notify_read(
        &self,
        recipient_user_uuid: Uuid,
        conversation_uuid: Uuid,
        reader_user_uuid: Uuid,
    ) -> BoxFuture<'_, ()>;
}

pub struct NoopMessageReadNotifier;

impl MessageReadNotifier for NoopMessageReadNotifier {
    fn notify_read(
        &self,
        _recipient_user_uuid: Uuid,
        _conversation_uuid: Uuid,
        _reader_user_uuid: Uuid,
    ) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
}

/// Строка peer-сводки до обогащения профилем (C# `ConversationPeerRow`).
#[derive(Debug, Clone)]
pub struct ConversationPeerRow {
    pub other_user_uuid: Uuid,
    pub last_message_uuid: Uuid,
    pub last_encrypted_for_me: Option<String>,
    pub last_content: Option<String>,
    pub last_message_at: DateTime<Utc>,
    pub last_is_from_me: bool,
    pub unread_count: i32,
}

/// Элемент списка диалогов после обогащения (ответ GET /api/messaging/conversations).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationListItemDto {
    pub conversation_uuid: Uuid,
    pub other_user_uuid: Uuid,
    pub other_username: String,
    pub other_display_name: String,
    pub other_avatar_uuid: Option<String>,
    pub last_message_encrypted_for_me: Option<String>,
    pub last_message_content: Option<String>,
    pub last_message_at: String,
    pub last_message_is_from_me: bool,
    pub unread_count: i32,
    pub other_user_is_online: bool,
    pub other_user_last_seen_at: Option<String>,
}

/// Страница диалогов.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationsPageDto {
    pub items: Vec<ConversationListItemDto>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

/// Элемент ленты сообщений (GET …/messages).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageItemDto {
    pub message_uuid: Uuid,
    pub sender_user_uuid: Uuid,
    pub encrypted_for_me: Option<String>,
    pub content: Option<String>,
    pub created_at: String,
    pub is_read: bool,
    pub is_from_me: bool,
    pub voice_asset_uuids: Vec<Uuid>,
    pub image_asset_uuids: Vec<Uuid>,
    pub video_asset_uuids: Vec<Uuid>,
}

/// Страница сообщений диалога.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagesPageDto {
    pub items: Vec<MessageItemDto>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

/// Тело POST …/messages.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostConversationMessageRequest {
    pub encrypted_for_receiver: String,
    pub encrypted_for_sender: String,
    #[serde(default)]
    pub voice_asset_uuids: Vec<Uuid>,
    #[serde(default)]
    pub image_asset_uuids: Vec<Uuid>,
    #[serde(default)]
    pub video_asset_uuids: Vec<Uuid>,
    #[serde(default)]
    pub encrypted_push_previews: Vec<EncryptedPushPreview>,
    /// Deprecated (errata-5): игнорируется сервером. Поле сохранено только для
    /// десериализации запросов старых клиентов; plaintext-превью в push не попадает.
    #[serde(default)]
    pub push_preview: Option<String>,
}

/// Ответ POST …/messages.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageResultDto {
    pub message_uuid: Uuid,
    pub created_at: String,
    pub encrypted_for_me: String,
}

/// Исход DELETE message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteMessageOutcome {
    NotFound,
    Forbidden,
    Success,
}

/// Исход DELETE conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteConversationOutcome {
    NotFound,
    Success,
}

// ── E2E key backup (GET/PUT /api/messaging/e2e/*) ───────────────────────────

/// KDF parameters embedded in key/recovery backup payloads.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfParamsDto {
    pub name: String,
    pub memory_ki_b: i32,
    pub iterations: i32,
    pub parallelism: i32,
    pub salt_base64_url: String,
}

/// AEAD parameters embedded in key/recovery backup payloads.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AeadParamsDto {
    pub name: String,
    pub nonce_base64_url: String,
}

/// Full password-encrypted key backup (GET/PUT body).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyBackupPayloadDto {
    pub version: i32,
    pub backup_revision: i32,
    pub backup_key_id: Uuid,
    pub user_uuid: Uuid,
    pub primary_key_epoch_id: Uuid,
    pub epoch_set_revision: i32,
    pub epoch_set_hash_base64_url: String,
    pub kdf: KdfParamsDto,
    pub aead: AeadParamsDto,
    pub ciphertext_base64_url: String,
}

/// Epoch public identity entry on PUT key-backup.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpochIdentityPublicKeyEntryDto {
    pub key_epoch_id: Uuid,
    pub epoch_account_identity_public_key_base64_url: String,
}

/// PUT/POST /api/messaging/e2e/key-backup request body.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PutKeyBackupRequestDto {
    pub key_backup: KeyBackupPayloadDto,
    #[serde(default)]
    pub epoch_identity_public_keys: Vec<EpochIdentityPublicKeyEntryDto>,
}

/// GET /api/messaging/e2e/state response.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eStateResponseDto {
    pub state: String,
    pub freeze: bool,
    pub updated_at: String,
}

/// Wordlist metadata embedded in recovery backup.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordlistInfoDto {
    pub id: String,
    pub words_count: i32,
}

/// Full recovery backup payload (PUT and GET with ciphertext).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryBackupPayloadDto {
    pub version: i32,
    pub recovery_revision: i32,
    pub recovery_key_id: Uuid,
    pub user_uuid: Uuid,
    pub primary_key_epoch_id: Uuid,
    pub epoch_set_revision: i32,
    pub epoch_set_hash_base64_url: String,
    pub wordlist: WordlistInfoDto,
    pub kdf: KdfParamsDto,
    pub aead: AeadParamsDto,
    pub ciphertext_base64_url: String,
}

/// GET recovery-backup/{recoveryKeyId} response: полный payload + (в FSM `recovering`)
/// короткоживущий `recoveryUnlockToken` для последующего `unlock-complete` (errata-5).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryBackupResponseDto {
    #[serde(flatten)]
    pub payload: RecoveryBackupPayloadDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_unlock_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_unlock_token_expires_at: Option<String>,
}

/// Recovery backup metadata only (GET list — no ciphertext).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryBackupMetaDto {
    pub recovery_key_id: Uuid,
    pub recovery_revision: i32,
    pub primary_key_epoch_id: Uuid,
    pub epoch_set_revision: i32,
    pub epoch_set_hash_base64_url: String,
    pub wordlist: WordlistInfoDto,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_at: Option<String>,
}

/// Request body for POST /api/messaging/e2e/epochs (Create epoch).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEpochRequestDto {
    pub account_recovery_session_id: Uuid,
    pub idempotency_key: Uuid,
    pub ux_confirmation_id: Uuid,
    pub new_key_epoch_id: Uuid,
    pub new_epoch_account_identity_public_key_base64_url: String,
    pub new_device_signing_public_key_base64_url: String,
    pub new_device_agreement_public_key_base64_url: String,
    pub new_device_display_name: Option<String>,
    pub key_backup: KeyBackupPayloadDto,
}

/// Response from POST .../unlock-complete/challenge.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockChallengeResponseDto {
    pub challenge_id: Uuid,
    pub reset_request_id: Uuid,
    pub expires_at: String,
    pub canonical_payload_preview: String,
}

/// One entry in epochIdentityPublicKeys / epochUnlockSignatures arrays.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpochUnlockEntryDto {
    pub key_epoch_id: Uuid,
    pub value_base64_url: String,
}

/// Request body for POST /api/messaging/e2e/unlock-complete.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockCompleteRequestDto {
    pub reset_request_id: Uuid,
    pub idempotency_key: Uuid,
    pub challenge_id: Uuid,
    pub recovered_key_epoch_ids: Vec<Uuid>,
    pub epoch_identity_public_keys: Vec<EpochUnlockEntryDto>,
    pub epoch_unlock_signatures: Vec<EpochUnlockEntryDto>,
    pub key_backup: KeyBackupPayloadDto,
    pub new_device_signing_public_key_base64_url: String,
    pub new_device_agreement_public_key_base64_url: String,
    pub recovery_unlock_token: Option<String>,
    pub trusted_device_approval_token: Option<String>,
}

/// Request body for POST .../epochs/{keyEpochId}/devices/pending.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddPendingDeviceRequestDto {
    pub signing_public_key_base64_url: String,
    pub agreement_public_key_base64_url: String,
    pub display_name: Option<String>,
}

/// Response entry for GET .../epochs/{keyEpochId}/devices.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceKeyEntryDto {
    pub device_uuid: Uuid,
    pub key_epoch_id: Uuid,
    pub display_name: String,
    pub signing_public_key_base64_url: String,
    pub agreement_public_key_base64_url: String,
    pub status: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<String>,
}

/// Result for POST .../epochs/{keyEpochId}/devices/pending.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddPendingDeviceResponseDto {
    pub device_uuid: Uuid,
}

/// Request body for POST .../epochs/{keyEpochId}/devices/{deviceUuid}/approve.
///
/// Старое **active** устройство той же epoch подписывает canonical payload
/// `flora.messaging.device-approve.v1 | userUuid | keyEpochId | newDeviceUuid | approvingDeviceUuid`
/// своим device signing key (Ed25519). JWT сам по себе не делает устройство trusted.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveDeviceRequestDto {
    pub approving_device_uuid: Uuid,
    pub approval_signature_base64_url: String,
}

/// Result for POST .../devices/{deviceUuid}/approve: устройство переведено в active,
/// выдан короткоживущий `trustedDeviceApprovalToken` для `unlock-complete`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveDeviceResponseDto {
    pub device_uuid: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trusted_device_approval_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trusted_device_approval_token_expires_at: Option<String>,
}

/// Request body for POST .../epochs/{keyEpochId}/devices/{deviceUuid}/recover-key.
///
/// `envelope` — opaque `DeviceToDeviceRecoveryEnvelope` (e2e-security.md
/// §DeviceToDeviceRecoveryEnvelope): сервер валидирует форму, binding и подпись
/// source-устройства (fscp-core), но не расшифровывает ciphertext.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostDeviceRecoveryEnvelopeRequestDto {
    pub envelope: serde_json::Value,
}

/// Response for POST .../recover-key.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostDeviceRecoveryEnvelopeResponseDto {
    pub recovery_request_id: Uuid,
    pub expires_at: String,
}

/// Response for GET .../recover-key: сохранённый конверт для target-устройства.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecoveryEnvelopeResponseDto {
    pub envelope: serde_json::Value,
    pub source_device_uuid: Uuid,
    pub recovery_request_id: Uuid,
    pub created_at: String,
    pub expires_at: String,
}

// ── Legacy E2E public key (`/api/auth/.../e2e-public-key`) ─────────────────

/// PUT/POST `/api/auth/me/e2e-public-key` body (C# `SetE2EPublicKeyRequest`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetE2ePublicKeyRequestDto {
    pub public_key_base64: Option<String>,
    /// Client may send a UUID string; invalid/empty → ignored (server may mint).
    pub device_uuid: Option<String>,
}

/// PUT/POST `/api/auth/me/e2e-public-key` success body.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetE2ePublicKeyResponseDto {
    pub message: String,
    pub device_uuid: Option<Uuid>,
}

/// GET `/api/auth/users/{userUuid}/e2e-public-key` success body.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserE2ePublicKeyDto {
    pub public_key_base64: String,
    pub device_uuid: Option<Uuid>,
}

// ── Legacy `/api/auth/conversations*` + `/api/auth/messages*` (ImportedSocialController) ──

/// Элемент `GET /api/auth/conversations` (массив, без cursor-page).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyConversationListItemDto {
    pub other_user_uuid: Uuid,
    pub other_username: String,
    pub other_display_name: String,
    pub other_avatar_uuid: Option<String>,
    pub other_user_e2e_public_key_base64: Option<String>,
    pub last_message_uuid: Uuid,
    pub last_message_content: Option<String>,
    pub last_message_encrypted_for_me: Option<String>,
    pub last_message_is_from_me: bool,
    pub last_message_at: String,
    pub unread_count: i32,
    pub other_user_is_online: bool,
    pub other_user_last_seen_at: Option<String>,
}

/// Элемент `GET /api/auth/conversations/with/{otherUserUuid}`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMessageThreadItemDto {
    pub message_uuid: Uuid,
    pub sender_user_uuid: Uuid,
    pub receiver_user_uuid: Uuid,
    pub content: Option<String>,
    pub encrypted_for_me: Option<String>,
    pub created_at: String,
    pub is_read: bool,
    pub is_from_me: bool,
}

/// Тело `POST /api/auth/messages` (C# `SendMessageRequest`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacySendMessageRequest {
    pub to_user_uuid: Uuid,
    pub content: Option<String>,
    pub encrypted_for_receiver: Option<String>,
    pub encrypted_for_sender: Option<String>,
    #[serde(default)]
    pub voice_asset_uuids: Vec<Uuid>,
    #[serde(default)]
    pub image_asset_uuids: Vec<Uuid>,
}

/// Ответ `POST /api/auth/messages`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacySendMessageResultDto {
    pub message_uuid: Uuid,
    pub content: Option<String>,
    pub encrypted_for_me: String,
    pub created_at: String,
}

/// Upload image asset response.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadImageAssetResultDto {
    pub image_asset_uuid: Uuid,
    pub content_type: String,
}

/// Upload voice asset response.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadVoiceAssetResultDto {
    pub voice_asset_uuid: Uuid,
    pub content_type: String,
    pub duration_ms: i32,
}

/// Upload video asset response.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadVideoAssetResultDto {
    pub video_asset_uuid: Uuid,
    pub content_type: String,
}

// ── Chat list overlay (folders + archive/mute; no FSCP) ─────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChatListEntityKindDto {
    Folder,
    Group,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatListEntityDto {
    pub id: Uuid,
    pub kind: ChatListEntityKindDto,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_uri: Option<String>,
    pub member_peer_uuids: Vec<Uuid>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatListOverlayDto {
    pub entities: Vec<ChatListEntityDto>,
    pub archived_peer_uuids: Vec<Uuid>,
    pub muted_peer_uuids: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateChatFolderRequest {
    pub kind: ChatListEntityKindDto,
    pub label: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub avatar_uri: Option<String>,
    #[serde(default)]
    pub member_peer_uuids: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddChatFolderMemberRequest {
    pub other_user_uuid: Uuid,
}
