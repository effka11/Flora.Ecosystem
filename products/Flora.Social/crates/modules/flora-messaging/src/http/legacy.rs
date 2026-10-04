//! Legacy `/api/auth/conversations*` + `/api/auth/messages*` — ImportedSocialController parity.
//! Thin adapters over ConversationService / AssetService; shapes differ from `/api/messaging/*`.

use axum::Json;
use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use flora_messaging_contracts::{
    DeleteConversationOutcome, DeleteMessageOutcome, LegacySendMessageRequest,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::application::SendMessageError;
use crate::http::{CurrentUser, MessagingState};

#[derive(Debug, Deserialize)]
pub(crate) struct LegacyMessagesQuery {
    #[serde(default)]
    skip: i32,
    #[serde(default = "default_take")]
    take: i32,
}

fn default_take() -> i32 {
    50
}

/// GET `/api/auth/conversations`
pub async fn get_conversations(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    match state.conversations.legacy_conversations(user.0).await {
        Ok(mut items) => {
            let uuids: Vec<Uuid> = items.iter().map(|i| i.other_user_uuid).collect();
            let keys = state.e2e.public_keys_by_uuids(&uuids).await;
            for item in &mut items {
                item.other_user_e2e_public_key_base64 = keys.get(&item.other_user_uuid).cloned();
            }
            Json(items).into_response()
        }
        Err(e) => crate::http::internal(e),
    }
}

/// GET `/api/auth/conversations/with/{other_user_uuid}`
pub async fn get_messages_with(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(other_user_uuid): Path<Uuid>,
    Query(q): Query<LegacyMessagesQuery>,
) -> Response {
    match state
        .conversations
        .legacy_messages_with(user.0, other_user_uuid, q.skip, q.take)
        .await
    {
        Ok(Ok(items)) => Json(items).into_response(),
        Ok(Err(SendMessageError::BadRequest(msg))) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Ok(Err(_)) => crate::http::internal("unexpected legacy messages error".into()),
        Err(e) => crate::http::internal(e),
    }
}

/// PATCH `/api/auth/conversations/with/{other_user_uuid}/read`
pub async fn mark_read(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(other_user_uuid): Path<Uuid>,
) -> Response {
    match state
        .conversations
        .legacy_mark_read(user.0, other_user_uuid)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => crate::http::internal(e),
    }
}

/// DELETE `/api/auth/conversations/with/{other_user_uuid}`
pub async fn delete_conversation(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(other_user_uuid): Path<Uuid>,
) -> Response {
    match state
        .conversations
        .legacy_delete_conversation(user.0, other_user_uuid)
        .await
    {
        Ok(Ok(DeleteConversationOutcome::Success))
        | Ok(Ok(DeleteConversationOutcome::NotFound)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Ok(DeleteConversationOutcome::Conflict)) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "Диалог сейчас нельзя удалить."
            })),
        )
            .into_response(),
        Ok(Err(SendMessageError::BadRequest(msg))) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Ok(Err(_)) => crate::http::internal("unexpected legacy delete conversation".into()),
        Err(e) => crate::http::internal(e),
    }
}

/// POST `/api/auth/messages`
pub async fn send_message(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<LegacySendMessageRequest>,
) -> Response {
    match state.conversations.legacy_send_message(user.0, body).await {
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
        Err(e) => crate::http::map_send_err(e),
    }
}

/// DELETE `/api/auth/messages/{message_uuid}`
pub async fn delete_message(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(message_uuid): Path<Uuid>,
) -> Response {
    match state
        .conversations
        .legacy_delete_message(user.0, message_uuid)
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
        Ok(DeleteMessageOutcome::Forbidden) => StatusCode::FORBIDDEN.into_response(),
        Ok(DeleteMessageOutcome::Conflict) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "Сообщение сейчас нельзя удалить."
            })),
        )
            .into_response(),
        Err(e) => crate::http::internal(e),
    }
}
