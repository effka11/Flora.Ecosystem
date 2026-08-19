//! JWT-маршруты FSCP-FRANK. Хендлеры не принимают plaintext / frankingKey.

use axum::Json;
use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use flora_messaging_contracts::{
    CreateFrankingReportRequest, ForwardFrankingReportRequest, PostFrankingWrapsRequest,
    ResolveFrankingReportRequest,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::application::FrankingError;
use crate::http::{CurrentUser, MessagingState, internal};

pub async fn server_key(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    Json(state.franking.server_key_for(user.0).await).into_response()
}

pub async fn create_report(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<CreateFrankingReportRequest>,
) -> Response {
    match state.franking.create_report(user.0, body).await {
        Ok(dto) => (StatusCode::CREATED, Json(dto)).into_response(),
        Err(e) => map_franking_err(e),
    }
}

pub async fn get_report(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(report_uuid): Path<Uuid>,
) -> Response {
    match state.franking.get_report(user.0, report_uuid).await {
        Ok(dto) => Json(dto).into_response(),
        Err(e) => map_franking_err(e),
    }
}

pub async fn add_wraps(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(report_uuid): Path<Uuid>,
    Json(body): Json<PostFrankingWrapsRequest>,
) -> Response {
    match state.franking.add_wraps(user.0, report_uuid, body).await {
        Ok(dto) => Json(dto).into_response(),
        Err(e) => map_franking_err(e),
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct QueueQuery {
    cursor: Option<String>,
}

pub async fn queue(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<QueueQuery>,
) -> Response {
    match state.franking.queue(user.0, q.cursor.as_deref()).await {
        Ok(dto) => Json(dto).into_response(),
        Err(e) => map_franking_err(e),
    }
}

pub async fn claim(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(report_uuid): Path<Uuid>,
) -> Response {
    match state.franking.claim(user.0, report_uuid).await {
        Ok(dto) => Json(dto).into_response(),
        Err(e) => map_franking_err(e),
    }
}

pub async fn release(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(report_uuid): Path<Uuid>,
) -> Response {
    match state.franking.release(user.0, report_uuid).await {
        Ok(dto) => Json(dto).into_response(),
        Err(e) => map_franking_err(e),
    }
}

pub async fn disclosure(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(report_uuid): Path<Uuid>,
) -> Response {
    match state.franking.disclosure(user.0, report_uuid).await {
        Ok(dto) => Json(dto).into_response(),
        Err(e) => map_franking_err(e),
    }
}

pub async fn forward(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(report_uuid): Path<Uuid>,
    Json(body): Json<ForwardFrankingReportRequest>,
) -> Response {
    match state.franking.forward(user.0, report_uuid, body).await {
        Ok(dto) => Json(dto).into_response(),
        Err(e) => map_franking_err(e),
    }
}

pub async fn resolve(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(report_uuid): Path<Uuid>,
    Json(body): Json<ResolveFrankingReportRequest>,
) -> Response {
    match state.franking.resolve(user.0, report_uuid, body).await {
        Ok(dto) => Json(dto).into_response(),
        Err(e) => map_franking_err(e),
    }
}

pub async fn audit(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(report_uuid): Path<Uuid>,
) -> Response {
    match state.franking.audit(user.0, report_uuid).await {
        Ok(dto) => Json(dto).into_response(),
        Err(e) => map_franking_err(e),
    }
}

fn map_franking_err(e: FrankingError) -> Response {
    match e {
        FrankingError::BadRequest(msg) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        FrankingError::NotFound(msg) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        FrankingError::Forbidden(msg) => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        FrankingError::Conflict(msg) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        FrankingError::TooManyRequests(msg) => (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        FrankingError::Unavailable(msg) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        FrankingError::Internal(msg) => internal(msg),
    }
}
