//! HTTP Messaging — unread, conversations, messages, assets, E2E state (Messaging:ServeNative).

mod assets;
mod e2e;
mod legacy;

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{DefaultBodyLimit, Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use flora_messaging_contracts::{
    AddChatFolderMemberRequest, CreateChatFolderRequest, DeleteConversationOutcome,
    DeleteMessageOutcome, PostConversationMessageRequest,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::application::{
    AssetService, ChatListError, ChatListService, ConversationService, E2eEpochService,
    E2eKeyBackupService, SendMessageError,
};

/// JWT user (тот же тип, что внедряет flora-social).
#[derive(Clone, Copy, Debug)]
pub struct CurrentUser(pub Uuid);

/// ~37 MiB — паритет C# RequestSizeLimit (36 MiB video + 1 MiB buffer).
const MESSAGING_BODY_LIMIT: usize = 37 * 1024 * 1024;

#[derive(Clone)]
pub struct MessagingState {
    pub conversations: Arc<ConversationService>,
    pub chat_list: Arc<ChatListService>,
    pub assets: Arc<AssetService>,
    pub e2e: Arc<E2eKeyBackupService>,
    pub epochs: Arc<E2eEpochService>,
}

pub fn protected_router(state: MessagingState) -> Router {
    Router::new()
        .route("/api/messaging/unread-count", get(get_unread_count))
        .route("/api/messaging/conversations", get(get_conversations))
        .route(
            "/api/messaging/push-preview-targets/{recipient_uuid}",
            get(get_push_preview_targets),
        )
        .route(
            "/api/messaging/conversations/{conversation_uuid}/messages",
            get(get_messages).post(post_message),
        )
        .route(
            "/api/messaging/conversations/{conversation_uuid}/messages/{message_uuid}",
            delete(delete_message),
        )
        .route(
            "/api/messaging/conversations/{conversation_uuid}/read",
            post(mark_read),
        )
        .route(
            "/api/messaging/conversations/{conversation_uuid}/typing",
            post(post_typing),
        )
        .route(
            "/api/messaging/conversations/{conversation_uuid}",
            delete(delete_conversation),
        )
        .route(
            "/api/messaging/chat-list-overlay",
            get(get_chat_list_overlay),
        )
        .route("/api/messaging/chat-folders", post(create_chat_folder))
        .route(
            "/api/messaging/chat-folders/{folder_id}",
            delete(delete_chat_folder),
        )
        .route(
            "/api/messaging/chat-folders/{folder_id}/members",
            post(add_chat_folder_member),
        )
        .route(
            "/api/messaging/conversations/{conversation_uuid}/archive",
            post(archive_conversation),
        )
        .route(
            "/api/messaging/conversations/{conversation_uuid}/unarchive",
            post(unarchive_conversation),
        )
        .route(
            "/api/messaging/conversations/{conversation_uuid}/mute",
            post(mute_conversation),
        )
        .route(
            "/api/messaging/conversations/{conversation_uuid}/unmute",
            post(unmute_conversation),
        )
        .route("/api/messaging/image-assets", post(assets::upload_image))
        .route(
            "/api/messaging/image-assets/{asset_uuid}",
            get(assets::get_image),
        )
        .route("/api/messaging/voice-assets", post(assets::upload_voice))
        .route(
            "/api/messaging/voice-assets/{asset_uuid}",
            get(assets::get_voice),
        )
        .route("/api/messaging/video-assets", post(assets::upload_video))
        .route(
            "/api/messaging/video-assets/{asset_uuid}",
            get(assets::get_video),
        )
        .route("/api/messaging/e2e/state", get(e2e::get_e2e_state))
        .route(
            "/api/messaging/e2e/key-backup",
            get(e2e::get_key_backup)
                .put(e2e::put_key_backup)
                .post(e2e::put_key_backup),
        )
        .route(
            "/api/messaging/e2e/recovery-backups",
            get(e2e::get_recovery_backups),
        )
        .route(
            "/api/messaging/e2e/recovery-backup/{recovery_key_id}",
            get(e2e::get_recovery_backup),
        )
        .route(
            "/api/messaging/e2e/recovery-backup",
            put(e2e::put_recovery_backup),
        )
        .route("/api/messaging/e2e/lock", post(e2e::lock_e2e))
        .route("/api/messaging/e2e/epochs", post(e2e::create_epoch))
        .route(
            "/api/messaging/e2e/unlock-complete/challenge",
            post(e2e::request_unlock_challenge),
        )
        .route(
            "/api/messaging/e2e/unlock-complete",
            post(e2e::unlock_complete),
        )
        .route(
            "/api/messaging/e2e/epochs/{key_epoch_id}/devices/pending",
            post(e2e::add_pending_device),
        )
        .route(
            "/api/messaging/e2e/epochs/{key_epoch_id}/devices",
            get(e2e::get_devices),
        )
        .route(
            "/api/messaging/e2e/epochs/{key_epoch_id}/devices/{device_uuid}",
            delete(e2e::revoke_device),
        )
        .route(
            "/api/messaging/e2e/epochs/{key_epoch_id}/devices/{device_uuid}/approve",
            post(e2e::approve_device),
        )
        // POST-алиас revoke — паритет с таблицей Devices в e2e-security.md.
        .route(
            "/api/messaging/e2e/epochs/{key_epoch_id}/devices/{device_uuid}/revoke",
            post(e2e::revoke_device),
        )
        // D2D recovery transport: POST — source-устройство кладёт конверт,
        // GET — target-устройство забирает (e2e-security.md §Devices recover-key).
        .route(
            "/api/messaging/e2e/epochs/{key_epoch_id}/devices/{device_uuid}/recover-key",
            post(e2e::post_device_recovery_envelope).get(e2e::get_device_recovery_envelope),
        )
        // Legacy auth-prefixed public key (ImportedSocialController / FSCP bootstrap).
        .route(
            "/api/auth/me/e2e-public-key",
            put(e2e::set_my_e2e_public_key).post(e2e::set_my_e2e_public_key),
        )
        .route(
            "/api/auth/users/{user_uuid}/e2e-public-key",
            get(e2e::get_user_e2e_public_key),
        )
        // Legacy auth-prefixed conversations/messages (ImportedSocialController; Web socialApi.ts).
        .route("/api/auth/conversations", get(legacy::get_conversations))
        .route(
            "/api/auth/conversations/with/{other_user_uuid}",
            get(legacy::get_messages_with).delete(legacy::delete_conversation),
        )
        .route(
            "/api/auth/conversations/with/{other_user_uuid}/read",
            patch(legacy::mark_read),
        )
        .route("/api/auth/messages", post(legacy::send_message))
        .route(
            "/api/auth/messages/voice-assets",
            post(assets::upload_voice),
        )
        .route(
            "/api/auth/messages/voice-assets/{asset_uuid}",
            get(assets::get_voice),
        )
        .route(
            "/api/auth/messages/image-assets",
            post(assets::upload_image),
        )
        .route(
            "/api/auth/messages/image-assets/{asset_uuid}",
            get(assets::get_image),
        )
        .route(
            "/api/auth/messages/{message_uuid}",
            delete(legacy::delete_message),
        )
        .layer(DefaultBodyLimit::max(MESSAGING_BODY_LIMIT))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct ConversationsQuery {
    cursor: Option<String>,
    #[serde(default = "default_take")]
    take: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessagesQuery {
    cursor: Option<String>,
    #[serde(default = "default_messages_take")]
    take: i32,
    #[serde(alias = "other_user_uuid")]
    other_user_uuid: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationPeerQuery {
    #[serde(alias = "other_user_uuid")]
    other_user_uuid: Option<Uuid>,
}

fn default_take() -> i32 {
    20
}

fn default_messages_take() -> i32 {
    50
}

async fn get_unread_count(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    match state.conversations.total_unread_count(user.0).await {
        Ok(count) => Json(serde_json::json!({ "unreadCount": count })).into_response(),
        Err(e) => internal(e),
    }
}

async fn get_conversations(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<ConversationsQuery>,
) -> Response {
    match state
        .conversations
        .conversations_page(user.0, q.cursor.as_deref(), q.take)
        .await
    {
        Ok(page) => Json(page).into_response(),
        Err(e) => internal(e),
    }
}

async fn get_messages(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(conversation_uuid): Path<Uuid>,
    Query(q): Query<MessagesQuery>,
) -> Response {
    match state
        .conversations
        .messages_page(
            user.0,
            conversation_uuid,
            q.other_user_uuid,
            q.cursor.as_deref(),
            q.take,
        )
        .await
    {
        Ok(Some(page)) => Json(page).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Разговор не найден." })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

async fn get_push_preview_targets(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(recipient_uuid): Path<Uuid>,
) -> Response {
    match state
        .conversations
        .push_preview_targets(user.0, recipient_uuid)
        .await
    {
        Ok(targets) => Json(targets).into_response(),
        Err(SendMessageError::Forbidden(msg)) => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(SendMessageError::NotFound(msg)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(SendMessageError::BadRequest(msg)) => internal(msg),
    }
}

async fn post_message(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(conversation_uuid): Path<Uuid>,
    Json(body): Json<PostConversationMessageRequest>,
) -> Response {
    match state
        .conversations
        .send_message(user.0, conversation_uuid, body)
        .await
    {
        Ok(result) => Json(result).into_response(),
        Err(SendMessageError::BadRequest(msg)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(SendMessageError::NotFound(msg)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(SendMessageError::Forbidden(msg)) => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
    }
}

async fn mark_read(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(conversation_uuid): Path<Uuid>,
    Query(q): Query<ConversationPeerQuery>,
) -> Response {
    match state
        .conversations
        .mark_read(user.0, conversation_uuid, q.other_user_uuid)
        .await
    {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Разговор не найден." })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TypingBody {
    is_typing: bool,
}

async fn post_typing(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(conversation_uuid): Path<Uuid>,
    Query(q): Query<ConversationPeerQuery>,
    Json(body): Json<TypingBody>,
) -> Response {
    match state
        .conversations
        .set_typing(user.0, conversation_uuid, q.other_user_uuid, body.is_typing)
        .await
    {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Разговор не найден." })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

async fn delete_conversation(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(conversation_uuid): Path<Uuid>,
    Query(q): Query<ConversationPeerQuery>,
) -> Response {
    match state
        .conversations
        .delete_conversation(user.0, conversation_uuid, q.other_user_uuid)
        .await
    {
        Ok(DeleteConversationOutcome::Success) => StatusCode::NO_CONTENT.into_response(),
        Ok(DeleteConversationOutcome::NotFound) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Разговор не найден." })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

async fn delete_message(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path((conversation_uuid, message_uuid)): Path<(Uuid, Uuid)>,
) -> Response {
    match state
        .conversations
        .delete_message(user.0, conversation_uuid, message_uuid)
        .await
    {
        Ok(DeleteMessageOutcome::Success) => {
            Json(serde_json::json!({ "message": "Сообщение удалено." })).into_response()
        }
        Ok(DeleteMessageOutcome::NotFound) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Сообщение не найдено." })),
        )
            .into_response(),
        Ok(DeleteMessageOutcome::Forbidden) => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Можно удалить только своё сообщение." })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

async fn get_chat_list_overlay(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    match state.chat_list.overlay(user.0).await {
        Ok(dto) => Json(dto).into_response(),
        Err(e) => chat_list_err(e),
    }
}

async fn create_chat_folder(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<CreateChatFolderRequest>,
) -> Response {
    match state.chat_list.create_folder(user.0, body).await {
        Ok(dto) => (StatusCode::CREATED, Json(dto)).into_response(),
        Err(e) => chat_list_err(e),
    }
}

async fn delete_chat_folder(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(folder_id): Path<Uuid>,
) -> Response {
    match state.chat_list.delete_folder(user.0, folder_id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => chat_list_err(e),
    }
}

async fn add_chat_folder_member(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(folder_id): Path<Uuid>,
    Json(body): Json<AddChatFolderMemberRequest>,
) -> Response {
    match state
        .chat_list
        .add_folder_member(user.0, folder_id, body)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => chat_list_err(e),
    }
}

async fn archive_conversation(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(conversation_uuid): Path<Uuid>,
    Query(q): Query<ConversationPeerQuery>,
) -> Response {
    set_conversation_flag(
        &state,
        user.0,
        conversation_uuid,
        q.other_user_uuid,
        Some(true),
        None,
    )
    .await
}

async fn unarchive_conversation(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(conversation_uuid): Path<Uuid>,
    Query(q): Query<ConversationPeerQuery>,
) -> Response {
    set_conversation_flag(
        &state,
        user.0,
        conversation_uuid,
        q.other_user_uuid,
        Some(false),
        None,
    )
    .await
}

async fn mute_conversation(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(conversation_uuid): Path<Uuid>,
    Query(q): Query<ConversationPeerQuery>,
) -> Response {
    set_conversation_flag(
        &state,
        user.0,
        conversation_uuid,
        q.other_user_uuid,
        None,
        Some(true),
    )
    .await
}

async fn unmute_conversation(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(conversation_uuid): Path<Uuid>,
    Query(q): Query<ConversationPeerQuery>,
) -> Response {
    set_conversation_flag(
        &state,
        user.0,
        conversation_uuid,
        q.other_user_uuid,
        None,
        Some(false),
    )
    .await
}

async fn set_conversation_flag(
    state: &MessagingState,
    owner: Uuid,
    conversation_uuid: Uuid,
    other_user_uuid: Option<Uuid>,
    archived: Option<bool>,
    muted: Option<bool>,
) -> Response {
    let Some(other) = other_user_uuid.filter(|u| !u.is_nil()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Укажите otherUserUuid." })),
        )
            .into_response();
    };
    let result = match (archived, muted) {
        (Some(a), None) => {
            state
                .chat_list
                .set_archived(owner, conversation_uuid, other, a)
                .await
        }
        (None, Some(m)) => {
            state
                .chat_list
                .set_muted(owner, conversation_uuid, other, m)
                .await
        }
        _ => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Внутренняя ошибка сервера." })),
            )
                .into_response();
        }
    };
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => chat_list_err(e),
    }
}

fn chat_list_err(e: ChatListError) -> Response {
    match e {
        ChatListError::BadRequest(msg) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        ChatListError::NotFound(msg) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        ChatListError::Internal(msg) => internal(msg),
    }
}

pub(crate) fn internal(e: String) -> Response {
    tracing::error!(error = %e, "messaging http failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": "Внутренняя ошибка сервера." })),
    )
        .into_response()
}
