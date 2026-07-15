//! Multipart upload + bytea GET for image/voice/video assets.

use axum::Json;
use axum::extract::{Extension, Multipart, Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use uuid::Uuid;

use crate::application::AssetError;
use crate::http::{CurrentUser, MessagingState};

pub async fn upload_image(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    multipart: Multipart,
) -> Response {
    match parse_image_upload(user.0, multipart).await {
        Ok(input) => match state.assets.upload_image(
            user.0,
            input.to_user_uuid,
            input.content_type.as_deref(),
            input.file_content_type.as_deref(),
            &input.bytes,
        ).await {
            Ok(dto) => Json(dto).into_response(),
            Err(e) => asset_err(e),
        },
        Err(resp) => resp,
    }
}

pub async fn upload_voice(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    multipart: Multipart,
) -> Response {
    match parse_voice_upload(user.0, multipart).await {
        Ok(input) => match state
            .assets
            .upload_voice(
                user.0,
                input.to_user_uuid,
                input.duration_ms,
                input.file_content_type.as_deref(),
                &input.bytes,
            )
            .await
        {
            Ok(dto) => Json(dto).into_response(),
            Err(e) => asset_err(e),
        },
        Err(resp) => resp,
    }
}

pub async fn upload_video(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    multipart: Multipart,
) -> Response {
    match parse_video_upload(user.0, multipart).await {
        Ok(input) => match state.assets.upload_video(
            user.0,
            input.to_user_uuid,
            input.duration_ms,
            input.content_type.as_deref(),
            input.file_content_type.as_deref(),
            &input.bytes,
        ).await {
            Ok(dto) => Json(dto).into_response(),
            Err(e) => asset_err(e),
        },
        Err(resp) => resp,
    }
}

pub async fn get_image(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(asset_uuid): Path<Uuid>,
) -> Response {
    match state.assets.get_image(user.0, asset_uuid).await {
        Ok(blob) => image_video_blob_response(blob.bytes, &blob.content_type, "X-Flora-Image-Content-Type"),
        Err(e) => asset_err(e),
    }
}

pub async fn get_voice(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(asset_uuid): Path<Uuid>,
) -> Response {
    match state.assets.get_voice(user.0, asset_uuid).await {
        Ok(blob) => voice_blob_response(blob.bytes, &blob.content_type, blob.duration_ms.unwrap_or(0)),
        Err(e) => asset_err(e),
    }
}

pub async fn get_video(
    State(state): State<MessagingState>,
    Extension(user): Extension<CurrentUser>,
    Path(asset_uuid): Path<Uuid>,
) -> Response {
    match state.assets.get_video(user.0, asset_uuid).await {
        Ok(blob) => image_video_blob_response(blob.bytes, &blob.content_type, "X-Flora-Video-Content-Type"),
        Err(e) => asset_err(e),
    }
}

struct UploadInput {
    to_user_uuid: Uuid,
    content_type: Option<String>,
    file_content_type: Option<String>,
    duration_ms: i32,
    bytes: Vec<u8>,
}

async fn parse_image_upload(user: Uuid, mut multipart: Multipart) -> Result<UploadInput, Response> {
    let mut to_user_uuid = None;
    let mut content_type = None;
    let mut file_content_type = None;
    let mut bytes = None;

    while let Some(field) = multipart.next_field().await.map_err(multipart_bad)? {
        match field.name().unwrap_or("") {
            "toUserUuid" => {
                to_user_uuid = Some(parse_uuid_field(field, "toUserUuid").await?);
            }
            "contentType" => content_type = Some(field_text(field).await?),
            "file" => {
                file_content_type = field.content_type().map(|m| m.to_string());
                bytes = Some(field_bytes(field).await?);
            }
            _ => {
                let _ = field.bytes().await;
            }
        }
    }

    let Some(to_user_uuid) = to_user_uuid else {
        return Err(bad_request("toUserUuid обязателен."));
    };
    let Some(bytes) = bytes else {
        return Err(bad_request("Файл фото пуст."));
    };
    let _ = user;
    Ok(UploadInput {
        to_user_uuid,
        content_type,
        file_content_type,
        duration_ms: 0,
        bytes,
    })
}

async fn parse_voice_upload(user: Uuid, mut multipart: Multipart) -> Result<UploadInput, Response> {
    let mut to_user_uuid = None;
    let mut duration_ms = 0;
    let mut file_content_type = None;
    let mut bytes = None;

    while let Some(field) = multipart.next_field().await.map_err(multipart_bad)? {
        match field.name().unwrap_or("") {
            "toUserUuid" => {
                to_user_uuid = Some(parse_uuid_field(field, "toUserUuid").await?);
            }
            "durationMs" => {
                let t = field_text(field).await?;
                duration_ms = t.parse().unwrap_or(0);
            }
            "file" => {
                file_content_type = field.content_type().map(|m| m.to_string());
                bytes = Some(field_bytes(field).await?);
            }
            _ => {
                let _ = field.bytes().await;
            }
        }
    }

    let Some(to_user_uuid) = to_user_uuid else {
        return Err(bad_request("toUserUuid обязателен."));
    };
    let Some(bytes) = bytes else {
        return Err(bad_request("Файл голосового сообщения пуст."));
    };
    let _ = user;
    Ok(UploadInput {
        to_user_uuid,
        content_type: None,
        file_content_type,
        duration_ms,
        bytes,
    })
}

async fn parse_video_upload(user: Uuid, mut multipart: Multipart) -> Result<UploadInput, Response> {
    let mut to_user_uuid = None;
    let mut content_type = None;
    let mut file_content_type = None;
    let mut duration_ms = 0;
    let mut bytes = None;

    while let Some(field) = multipart.next_field().await.map_err(multipart_bad)? {
        match field.name().unwrap_or("") {
            "toUserUuid" => {
                to_user_uuid = Some(parse_uuid_field(field, "toUserUuid").await?);
            }
            "contentType" => content_type = Some(field_text(field).await?),
            "durationMs" => {
                let t = field_text(field).await?;
                duration_ms = t.parse().unwrap_or(0);
            }
            "file" => {
                file_content_type = field.content_type().map(|m| m.to_string());
                bytes = Some(field_bytes(field).await?);
            }
            _ => {
                let _ = field.bytes().await;
            }
        }
    }

    let Some(to_user_uuid) = to_user_uuid else {
        return Err(bad_request("toUserUuid обязателен."));
    };
    let Some(bytes) = bytes else {
        return Err(bad_request("Файл видео пуст."));
    };
    let _ = user;
    Ok(UploadInput {
        to_user_uuid,
        content_type,
        file_content_type,
        duration_ms,
        bytes,
    })
}

fn image_video_blob_response(bytes: Vec<u8>, content_type: &str, type_header: &'static str) -> Response {
    let mut headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(content_type) {
        headers.insert(type_header, v);
    }
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    (StatusCode::OK, headers, bytes).into_response()
}

fn voice_blob_response(bytes: Vec<u8>, content_type: &str, duration_ms: i32) -> Response {
    let mut headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(content_type) {
        headers.insert("X-Flora-Voice-Content-Type", v);
    }
    if let Ok(v) = HeaderValue::from_str(&duration_ms.to_string()) {
        headers.insert("X-Flora-Voice-Duration-Ms", v);
    }
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    (StatusCode::OK, headers, bytes).into_response()
}

fn asset_err(err: AssetError) -> Response {
    match err {
        AssetError::BadRequest(msg) => bad_request(&msg).into_response(),
        AssetError::NotFound(msg) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        AssetError::Forbidden => StatusCode::FORBIDDEN.into_response(),
        AssetError::Internal(e) => crate::http::internal(e),
    }
}

fn bad_request(msg: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({ "error": msg })),
    )
        .into_response()
}

fn multipart_bad(e: axum::extract::multipart::MultipartError) -> Response {
    bad_request(&e.to_string())
}

async fn field_text(field: axum::extract::multipart::Field<'_>) -> Result<String, Response> {
    field
        .text()
        .await
        .map_err(|e| bad_request(&e.to_string()))
}

async fn field_bytes(field: axum::extract::multipart::Field<'_>) -> Result<Vec<u8>, Response> {
    field
        .bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| bad_request(&e.to_string()))
}

async fn parse_uuid_field(
    field: axum::extract::multipart::Field<'_>,
    name: &str,
) -> Result<Uuid, Response> {
    let text = field_text(field).await?;
    Uuid::parse_str(text.trim()).map_err(|_| bad_request(&format!("Некорректный {name}.")))
}
