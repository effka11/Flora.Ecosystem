//! Контракты модуля Messaging — DTO и trait-порты без бизнес-логики (next-architecture.md §2.2).
//!
//! Публичные порты для Notifications (`MessageSentNotifier` / C# `IMessageSentNotifier`).
//! Чужим модулям разрешена зависимость только от этого crate (§2.3).

use std::fmt;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageConversationKind {
    Dm,
    GroupChat,
}

impl MessageConversationKind {
    pub fn as_realtime_str(self) -> &'static str {
        match self {
            Self::Dm => "dm",
            Self::GroupChat => "groupChat",
        }
    }
}

#[derive(Debug, Clone)]
pub struct MessageSentContext {
    /// Explicit conversation id (DM: `dm_conversation_uuid`; group: server group uuid).
    pub conversation_uuid: Uuid,
    pub recipient_user_uuid: Uuid,
    pub sender_user_uuid: Uuid,
    pub persisted_message_uuid: Uuid,
    pub wire_message_uuid: Uuid,
    pub encrypted_push_previews: Vec<EncryptedPushPreview>,
    /// When true, Notifications publishes SSE only (no FCM/APNs). Used for FSCP-G v1.
    pub skip_push: bool,
    /// SSE/client hint — must not be inferred from `skip_push`.
    pub kind: MessageConversationKind,
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

/// Слепая квитанция сервера (franking.md §4.3). Аддитивное поле GET messages.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerFrankReceiptDto {
    pub signature_base64_url: String,
    pub server_franking_key_id: Uuid,
    pub server_received_at: String,
}

impl fmt::Debug for ServerFrankReceiptDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServerFrankReceiptDto")
            .field("signature_base64_url", &"<redacted>")
            .field("server_franking_key_id", &self.server_franking_key_id)
            .field("server_received_at", &self.server_received_at)
            .finish()
    }
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
    #[serde(default)]
    pub server_frank_receipt: Option<ServerFrankReceiptDto>,
    #[serde(default)]
    pub frank_tag_base64_url: Option<String>,
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
    /// Живая franking-заявка держит ciphertext.
    Conflict,
    Success,
}

/// Исход DELETE conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteConversationOutcome {
    NotFound,
    /// Хотя бы одно сообщение диалога держит живая franking-заявка.
    Conflict,
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
    #[serde(default)]
    pub server_frank_receipt: Option<ServerFrankReceiptDto>,
    #[serde(default)]
    pub frank_tag_base64_url: Option<String>,
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

// ── FSCP-G group conversations (`/api/messaging/groups*`) ───────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGroupRequest {
    #[serde(default)]
    pub title: Option<String>,
    pub member_user_uuids: Vec<Uuid>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchGroupRequest {
    pub title: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddGroupMemberRequest {
    pub user_uuid: Uuid,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostGroupMessageRequest {
    pub encrypted_wire: String,
    /// Bound to group_message_*_assets (membership-scoped); empty for text-only.
    #[serde(default)]
    pub voice_asset_uuids: Vec<Uuid>,
    #[serde(default)]
    pub image_asset_uuids: Vec<Uuid>,
    /// Rejected if non-empty — group media v1 is voice/image only.
    #[serde(default)]
    pub video_asset_uuids: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMemberDto {
    pub user_uuid: Uuid,
    pub username: String,
    pub display_name: String,
    pub avatar_uuid: Option<String>,
    pub joined_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupListItemDto {
    pub conversation_uuid: Uuid,
    pub title: String,
    pub created_by_user_uuid: Uuid,
    pub created_at: String,
    pub member_count: i32,
    pub last_message_encrypted_wire: Option<String>,
    pub last_message_at: Option<String>,
    pub last_message_is_from_me: bool,
    /// Display name of last sender when not from viewer (never username).
    /// Absent/empty → clients render a local unknown-sender label in list preview.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_sender_display_name: Option<String>,
    pub unread_count: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupsPageDto {
    pub items: Vec<GroupListItemDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupDetailDto {
    pub conversation_uuid: Uuid,
    pub title: String,
    pub created_by_user_uuid: Uuid,
    pub created_at: String,
    pub members: Vec<GroupMemberDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMessageItemDto {
    pub message_uuid: Uuid,
    pub sender_user_uuid: Uuid,
    pub encrypted_wire: String,
    pub created_at: String,
    pub is_from_me: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMessagesPageDto {
    pub items: Vec<GroupMessageItemDto>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendGroupMessageResultDto {
    pub message_uuid: Uuid,
    pub created_at: String,
    pub encrypted_wire: String,
}

// ── FSCP-FRANK reports (exclusive claim) ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FrankingReportCategory {
    Abuse,
    Threats,
    Spam,
    Csam,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FrankingReportStatus {
    Open,
    Claimed,
    ClaimedAwaitingDisclosure,
    Resolved,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FrankingVerificationStatus {
    Verifiable,
    Unverifiable,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrankingDisclosureWrapDto {
    pub user_uuid: Uuid,
    pub device_uuid: Uuid,
    pub wrapped_key: String,
}

impl fmt::Debug for FrankingDisclosureWrapDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FrankingDisclosureWrapDto")
            .field("user_uuid", &self.user_uuid)
            .field("device_uuid", &self.device_uuid)
            .field("wrapped_key", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFrankingReportRequest {
    pub persisted_message_uuid: Uuid,
    pub category: FrankingReportCategory,
    pub disclosure_ciphertext: String,
    #[serde(default)]
    pub wraps: Vec<FrankingDisclosureWrapDto>,
}

impl fmt::Debug for CreateFrankingReportRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CreateFrankingReportRequest")
            .field("persisted_message_uuid", &self.persisted_message_uuid)
            .field("category", &self.category)
            .field("disclosure_ciphertext", &"<redacted>")
            .field("wraps", &self.wraps)
            .finish()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostFrankingWrapsRequest {
    pub wraps: Vec<FrankingDisclosureWrapDto>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardFrankingReportRequest {
    pub wraps: Vec<FrankingDisclosureWrapDto>,
}

/// Бан accused в момент закрытия анкеты. Отсутствие поля — резолв без бана.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountBlockRequest {
    /// Срок в днях, 1..=9999. `None` — навсегда.
    #[serde(default)]
    pub days: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveFrankingReportRequest {
    pub decision: FrankingResolveDecision,
    #[serde(default)]
    pub code: Option<String>,
    /// Отсутствие `accountBlock` или `null` означает резолв без бана.
    ///
    /// Объект без `days` или с `days: null` означает бессрочный бан; `days` задаёт срок
    /// в диапазоне 1..=9999. Диапазон и запрет бана для решения `rejected` проверяет
    /// обработчик позже (с ответом 400 для срока вне диапазона), а не serde.
    #[serde(default)]
    pub account_block: Option<AccountBlockRequest>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FrankingResolveDecision {
    Resolved,
    Rejected,
}

/// Signing public key plus optional submit-time wrap roster.
///
/// Wrap targets are nested on this frozen GET (`/franking/server-key`,
/// next-architecture.md §1.2) instead of a new path. Roster SQL must not
/// change the GET status: failure yields empty wraps and the signing key.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrankingServerKeyDto {
    pub server_franking_key_id: Option<Uuid>,
    pub public_key_base64_url: Option<String>,
    pub wrap_targets: FrankingWrapTargetsDto,
    pub reviewer_roster_ready: bool,
}

/// Active reviewer device for submit-time viewer-wrap (franking.md §4.7).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrankingWrapTargetDto {
    pub user_uuid: Uuid,
    pub device_uuid: Uuid,
    pub agreement_public_key_base64_url: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrankingWrapTargetsDto {
    pub items: Vec<FrankingWrapTargetDto>,
    pub own_items: Vec<FrankingWrapTargetDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrankingReportMetaDto {
    pub report_uuid: Uuid,
    pub persisted_message_uuid: Uuid,
    pub conversation_uuid: Uuid,
    pub category: FrankingReportCategory,
    pub status: FrankingReportStatus,
    pub claimed_by: Option<Uuid>,
    pub claimed_at: Option<String>,
    pub created_at: String,
    pub viewer_account_count: i64,
    pub has_disclosure: bool,
    pub verification_status: FrankingVerificationStatus,
    /// Public username of the reporter (DM receiver). Panel/reporter meta, not journal PII.
    pub reporter_username: Option<String>,
    /// Public username of the accused (DM sender). Panel/reporter meta, not journal PII.
    pub accused_username: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrankingQueueDto {
    pub items: Vec<FrankingReportMetaDto>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrankingOwnWrapDto {
    pub device_uuid: Uuid,
    pub wrapped_key: String,
}

impl fmt::Debug for FrankingOwnWrapDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FrankingOwnWrapDto")
            .field("device_uuid", &self.device_uuid)
            .field("wrapped_key", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrankingDisclosureDto {
    pub disclosure_ciphertext: String,
    pub wraps: Vec<FrankingOwnWrapDto>,
    pub server_frank_receipt: Option<ServerFrankReceiptDto>,
    pub frank_tag_base64_url: Option<String>,
    pub verification_status: FrankingVerificationStatus,
}

impl fmt::Debug for FrankingDisclosureDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FrankingDisclosureDto")
            .field("disclosure_ciphertext", &"<redacted>")
            .field("wraps", &self.wraps)
            .field("server_frank_receipt", &self.server_frank_receipt)
            .field(
                "frank_tag_base64_url",
                &self.frank_tag_base64_url.as_ref().map(|_| "<redacted>"),
            )
            .field("verification_status", &self.verification_status)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FrankingAuditEvent {
    WrapCreated,
    WrapDestroyed,
    Claimed,
    Released,
    Forwarded,
    DisclosureFetched,
    Resolved,
    Rejected,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrankingAuditEventDto {
    pub audit_uuid: Uuid,
    pub event: FrankingAuditEvent,
    pub actor_user_uuid: Uuid,
    pub subject_user_uuid: Option<Uuid>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrankingAuditDto {
    pub viewer_account_count: i64,
    pub events: Vec<FrankingAuditEventDto>,
}

#[cfg(test)]
mod franking_null_contract_tests {
    use super::*;

    #[test]
    fn resolve_without_account_block_deserializes_without_ban() {
        let request: ResolveFrankingReportRequest =
            serde_json::from_str(r#"{"decision":"rejected"}"#).expect("resolve request");

        assert!(request.account_block.is_none());
    }

    #[test]
    fn franking_optional_fields_serialize_as_explicit_null() {
        let item = MessageItemDto {
            message_uuid: Uuid::nil(),
            sender_user_uuid: Uuid::nil(),
            encrypted_for_me: None,
            content: None,
            created_at: String::new(),
            is_read: false,
            is_from_me: false,
            voice_asset_uuids: Vec::new(),
            image_asset_uuids: Vec::new(),
            video_asset_uuids: Vec::new(),
            server_frank_receipt: None,
            frank_tag_base64_url: None,
        };
        let item_json = serde_json::to_value(&item).expect("item json");
        assert!(item_json["serverFrankReceipt"].is_null());
        assert!(item_json["frankTagBase64Url"].is_null());

        let key = FrankingServerKeyDto {
            server_franking_key_id: None,
            public_key_base64_url: None,
            wrap_targets: FrankingWrapTargetsDto::default(),
            reviewer_roster_ready: false,
        };
        let key_json = serde_json::to_value(&key).expect("key json");
        assert!(key_json["serverFrankingKeyId"].is_null());
        assert!(key_json["publicKeyBase64Url"].is_null());
        assert_eq!(key_json["wrapTargets"]["items"], serde_json::json!([]));
        assert_eq!(key_json["reviewerRosterReady"], false);

        let wrap_targets = serde_json::to_value(FrankingWrapTargetsDto {
            items: vec![FrankingWrapTargetDto {
                user_uuid: Uuid::nil(),
                device_uuid: Uuid::nil(),
                agreement_public_key_base64_url: "pk".into(),
            }],
            own_items: vec![FrankingWrapTargetDto {
                user_uuid: Uuid::nil(),
                device_uuid: Uuid::nil(),
                agreement_public_key_base64_url: "own".into(),
            }],
        })
        .expect("wrap targets json");
        assert_eq!(
            wrap_targets["items"][0]["agreementPublicKeyBase64Url"],
            "pk"
        );
        assert_eq!(
            wrap_targets["ownItems"][0]["agreementPublicKeyBase64Url"],
            "own"
        );

        let disclosure = FrankingDisclosureDto {
            disclosure_ciphertext: String::new(),
            wraps: Vec::new(),
            server_frank_receipt: None,
            frank_tag_base64_url: None,
            verification_status: FrankingVerificationStatus::Unverifiable,
        };
        let disclosure_json = serde_json::to_value(&disclosure).expect("disclosure json");
        assert!(disclosure_json["serverFrankReceipt"].is_null());
        assert!(disclosure_json["frankTagBase64Url"].is_null());

        let queue = serde_json::to_value(FrankingQueueDto {
            items: Vec::new(),
            next_cursor: None,
            has_more: true,
        })
        .expect("queue json");
        assert_eq!(queue["hasMore"], true);
        assert!(queue["nextCursor"].is_null());
        assert!(queue["items"].as_array().is_some());

        let meta = FrankingReportMetaDto {
            report_uuid: Uuid::nil(),
            persisted_message_uuid: Uuid::nil(),
            conversation_uuid: Uuid::nil(),
            category: FrankingReportCategory::Abuse,
            status: FrankingReportStatus::Open,
            claimed_by: None,
            claimed_at: None,
            created_at: String::new(),
            viewer_account_count: 0,
            has_disclosure: false,
            verification_status: FrankingVerificationStatus::Unverifiable,
            reporter_username: None,
            accused_username: None,
        };
        let meta_json = serde_json::to_value(&meta).expect("meta json");
        assert!(meta_json["reporterUsername"].is_null());
        assert!(meta_json["accusedUsername"].is_null());

        let audit = serde_json::to_value(FrankingAuditEvent::WrapCreated).expect("audit json");
        assert_eq!(audit, "wrapCreated");
        let rejected = serde_json::to_value(FrankingAuditEvent::Rejected).expect("rejected json");
        assert_eq!(rejected, "rejected");
    }

    #[test]
    fn franking_secret_fields_are_redacted_in_debug() {
        let wrap = FrankingDisclosureWrapDto {
            user_uuid: Uuid::nil(),
            device_uuid: Uuid::nil(),
            wrapped_key: "wrap-secret".into(),
        };
        assert!(!format!("{wrap:?}").contains("wrap-secret"));

        let create = CreateFrankingReportRequest {
            persisted_message_uuid: Uuid::nil(),
            category: FrankingReportCategory::Abuse,
            disclosure_ciphertext: "cipher-secret".into(),
            wraps: vec![wrap],
        };
        let create_debug = format!("{create:?}");
        assert!(!create_debug.contains("cipher-secret"));
        assert!(!create_debug.contains("wrap-secret"));

        let receipt = ServerFrankReceiptDto {
            signature_base64_url: "sig-secret".into(),
            server_franking_key_id: Uuid::nil(),
            server_received_at: "2026-01-01T00:00:00.000Z".into(),
        };
        assert!(!format!("{receipt:?}").contains("sig-secret"));

        let disclosure = FrankingDisclosureDto {
            disclosure_ciphertext: "disc-secret".into(),
            wraps: vec![FrankingOwnWrapDto {
                device_uuid: Uuid::nil(),
                wrapped_key: "own-wrap-secret".into(),
            }],
            server_frank_receipt: Some(receipt),
            frank_tag_base64_url: Some("tag-secret".into()),
            verification_status: FrankingVerificationStatus::Unverifiable,
        };
        let disclosure_debug = format!("{disclosure:?}");
        assert!(!disclosure_debug.contains("disc-secret"));
        assert!(!disclosure_debug.contains("own-wrap-secret"));
        assert!(!disclosure_debug.contains("sig-secret"));
        assert!(!disclosure_debug.contains("tag-secret"));
    }
}
