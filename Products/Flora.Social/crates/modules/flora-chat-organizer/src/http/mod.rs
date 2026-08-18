//! HTTP `/api/chat-organizer` — FSCP-ORG opaque blob (ChatOrganizer:ServeNative).

mod account_block;

use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Extension, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use flora_chat_organizer_contracts::PutChatOrganizerRequest;
use flora_users_contracts::AccountSanctionStatus;
use uuid::Uuid;

use crate::application::{OrganizerService, PutOrganizerError};

/// ~256 KiB — выше MAX_ORGANIZER_WIRE_CHARS (~200k) из fscp-core.
const ORGANIZER_BODY_LIMIT: usize = 256 * 1024;

#[derive(Clone)]
pub struct OrganizerState {
    pub organizer: Arc<OrganizerService>,
}

/// Пользователь из JWT (внедряет flora-social middleware).
#[derive(Clone, Copy, Debug)]
pub struct CurrentUser(pub Uuid);

pub fn router(state: OrganizerState, account_status: Arc<dyn AccountSanctionStatus>) -> Router {
    let router = Router::new()
        .route(
            "/api/chat-organizer",
            get(get_blob).put(put_blob).post(put_blob),
        )
        .layer(DefaultBodyLimit::max(ORGANIZER_BODY_LIMIT))
        .with_state(state);
    account_block::write_gate(router, account_status)
}

async fn get_blob(
    State(state): State<OrganizerState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    match state.organizer.get(user.0).await {
        Ok(Some(dto)) => Json(dto).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Chat organizer blob not found." })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

async fn put_blob(
    State(state): State<OrganizerState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<PutChatOrganizerRequest>,
) -> Response {
    match state.organizer.put(user.0, &body.wire).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(PutOrganizerError::BadRequest(msg)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(PutOrganizerError::Conflict(msg)) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(PutOrganizerError::Internal(e)) => internal(e),
    }
}

fn internal(message: String) -> Response {
    tracing::error!(%message, "chat-organizer internal error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": "Internal server error." })),
    )
        .into_response()
}

#[cfg(test)]
mod wire_tests {
    use flora_chat_organizer_contracts::{ChatOrganizerBlobDto, PutChatOrganizerRequest};

    #[test]
    fn blob_dto_serializes_camel_case() {
        let dto = ChatOrganizerBlobDto {
            revision: 1,
            wire: "fscporg1:AAAA".into(),
            updated_at: "2026-08-02T00:00:00.000Z".into(),
        };
        let v = serde_json::to_value(&dto).unwrap();
        assert_eq!(v["revision"], 1);
        assert_eq!(v["wire"], "fscporg1:AAAA");
        assert_eq!(v["updatedAt"], "2026-08-02T00:00:00.000Z");
        assert!(v.get("updated_at").is_none());
    }

    #[test]
    fn put_request_deserializes_camel_case() {
        let raw = serde_json::json!({ "wire": "fscporg1:BBBB" });
        let req: PutChatOrganizerRequest = serde_json::from_value(raw).unwrap();
        assert_eq!(req.wire, "fscporg1:BBBB");
    }
}
