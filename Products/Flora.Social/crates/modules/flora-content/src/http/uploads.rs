//! Multipart upload post images / video — паритет `UploadPostImages` / `UploadPostVideo`.

use axum::Json;
use axum::extract::{Extension, Multipart, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use uuid::Uuid;

use crate::application::post_images::{
    MAX_POST_IMAGES_COUNT, UploadPostImagesError, UploadedFile,
};
use crate::application::post_videos::{UploadPostVideoError, UploadedVideoFile};
use crate::http::rate_limit::client_ip_key;
use crate::http::{ContentState, CurrentUser};

pub async fn upload_post_images(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path(post_uuid): Path<Uuid>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Response {
    let ip = client_ip_key(&headers);
    let key = format!("upload:{ip}:{}", user.0);
    if !state.upload_limiter.check_and_increment(&key) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }

    let files = match parse_post_image_files(multipart).await {
        Ok(files) => files,
        Err(resp) => return resp,
    };

    match state
        .post_images
        .upload(user.0, post_uuid, files)
        .await
    {
        Ok(Ok(body)) => Json(body).into_response(),
        Ok(Err(UploadPostImagesError::NotFound)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Пост не найден." })),
        )
            .into_response(),
        Ok(Err(UploadPostImagesError::Forbidden)) => StatusCode::FORBIDDEN.into_response(),
        Ok(Err(UploadPostImagesError::NoFiles)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Выберите хотя бы один файл (JPEG, PNG или WebP, до 5 МБ)."
            })),
        )
            .into_response(),
        Ok(Err(UploadPostImagesError::TooManyFiles)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("Не более {MAX_POST_IMAGES_COUNT} фото за раз.")
            })),
        )
            .into_response(),
        Ok(Err(UploadPostImagesError::PostImageCap)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("В посте не более {MAX_POST_IMAGES_COUNT} фото.")
            })),
        )
            .into_response(),
        Ok(Err(UploadPostImagesError::FileTooLarge)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Каждый файл не более 5 МБ." })),
        )
            .into_response(),
        Ok(Err(UploadPostImagesError::BadType)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Допустимые форматы: JPEG, PNG, WebP." })),
        )
            .into_response(),
        Ok(Err(UploadPostImagesError::Unreadable)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Не удалось прочитать изображение. Допустимые форматы: JPEG, PNG, WebP."
            })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "UploadPostImages failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "Не удалось сохранить фото. Попробуйте другой файл или позже."
                })),
            )
                .into_response()
        }
    }
}

async fn parse_post_image_files(mut multipart: Multipart) -> Result<Vec<UploadedFile>, Response> {
    let mut files = Vec::new();
    while let Some(field) = multipart.next_field().await.map_err(multipart_bad)? {
        let Some(name) = field.name().map(str::to_string) else {
            continue;
        };
        if name != "files" {
            continue;
        }
        let content_type = field
            .content_type()
            .map(str::to_string)
            .unwrap_or_default();
        let bytes = field.bytes().await.map_err(multipart_bad)?;
        files.push(UploadedFile {
            content_type,
            bytes: bytes.to_vec(),
        });
    }
    Ok(files)
}

fn multipart_bad(e: axum::extract::multipart::MultipartError) -> Response {
    tracing::warn!(error = %e, "post image multipart parse failed");
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({
            "error": "Выберите хотя бы один файл (JPEG, PNG или WebP, до 5 МБ)."
        })),
    )
        .into_response()
}

pub async fn upload_post_video(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path(post_uuid): Path<Uuid>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Response {
    let ip = client_ip_key(&headers);
    let key = format!("upload:{ip}:{}", user.0);
    if !state.upload_limiter.check_and_increment(&key) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }

    let file = match parse_post_video_file(multipart).await {
        Ok(file) => file,
        Err(resp) => return resp,
    };

    match state.post_videos.upload(user.0, post_uuid, file).await {
        Ok(Ok(body)) => Json(body).into_response(),
        Ok(Err(UploadPostVideoError::NotFound)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Пост не найден." })),
        )
            .into_response(),
        Ok(Err(UploadPostVideoError::Forbidden)) => StatusCode::FORBIDDEN.into_response(),
        Ok(Err(UploadPostVideoError::NoFile)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Выберите видеофайл (MP4, MOV, WebM или MKV, до 200 МБ)."
            })),
        )
            .into_response(),
        Ok(Err(UploadPostVideoError::FileTooLarge)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Видео не более 200 МБ." })),
        )
            .into_response(),
        Ok(Err(UploadPostVideoError::BadType)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Допустимые форматы: MP4, MOV, WebM, MKV."
            })),
        )
            .into_response(),
        Ok(Err(UploadPostVideoError::AlreadyHasVideo)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "К посту уже прикреплено видео." })),
        )
            .into_response(),
        Ok(Err(UploadPostVideoError::Unavailable)) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error": "Обработка видео временно недоступна (на сервере не настроен ffmpeg с SVT-AV1)."
            })),
        )
            .into_response(),
        Ok(Err(UploadPostVideoError::Unreadable)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Не удалось прочитать видеофайл. Допустимые форматы: MP4, MOV, WebM, MKV."
            })),
        )
            .into_response(),
        Ok(Err(UploadPostVideoError::TooLong)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Видео не длиннее 10 минут." })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "UploadPostVideo failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "Не удалось сохранить видео. Попробуйте другой файл или позже."
                })),
            )
                .into_response()
        }
    }
}

async fn parse_post_video_file(
    mut multipart: Multipart,
) -> Result<Option<UploadedVideoFile>, Response> {
    while let Some(field) = multipart.next_field().await.map_err(video_multipart_bad)? {
        let Some(name) = field.name().map(str::to_string) else {
            continue;
        };
        if name != "file" {
            continue;
        }
        let file_name = field.file_name().unwrap_or("").to_string();
        let content_type = field
            .content_type()
            .map(str::to_string)
            .unwrap_or_default();
        let bytes = field.bytes().await.map_err(video_multipart_bad)?;
        return Ok(Some(UploadedVideoFile {
            file_name,
            content_type,
            bytes: bytes.to_vec(),
        }));
    }
    Ok(None)
}

fn video_multipart_bad(e: axum::extract::multipart::MultipartError) -> Response {
    tracing::warn!(error = %e, "post video multipart parse failed");
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({
            "error": "Выберите видеофайл (MP4, MOV, WebM или MKV, до 200 МБ)."
        })),
    )
        .into_response()
}

pub async fn upload_community_avatar(
    State(state): State<ContentState>,
    Extension(user): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Response {
    use crate::application::communities::UploadCommunityAvatarError;

    let ip = client_ip_key(&headers);
    let key = format!("upload:{ip}:{}", user.0);
    if !state.upload_limiter.check_and_increment(&key) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }

    let file = match parse_community_avatar_file(multipart).await {
        Ok(file) => file,
        Err(resp) => return resp,
    };
    let Some(file) = file else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Выберите файл изображения (JPEG, PNG или WebP, до 2 МБ)."
            })),
        )
            .into_response();
    };

    match state
        .communities
        .upload_avatar(user.0, community_id, file)
        .await
    {
        Ok(Ok(body)) => Json(body).into_response(),
        Ok(Err(UploadCommunityAvatarError::Forbidden)) => StatusCode::FORBIDDEN.into_response(),
        Ok(Err(UploadCommunityAvatarError::NotFound)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Сообщество не найдено." })),
        )
            .into_response(),
        Ok(Err(UploadCommunityAvatarError::NoFile)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Выберите файл изображения (JPEG, PNG или WebP, до 2 МБ)."
            })),
        )
            .into_response(),
        Ok(Err(UploadCommunityAvatarError::FileTooLarge)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Файл не должен превышать 2 МБ." })),
        )
            .into_response(),
        Ok(Err(UploadCommunityAvatarError::BadType)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Допустимые форматы: JPEG, PNG, WebP." })),
        )
            .into_response(),
        Ok(Err(UploadCommunityAvatarError::Unreadable)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Файл не является корректным изображением (JPEG, PNG или WebP)."
            })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "UploadCommunityAvatar failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Внутренняя ошибка сервера." })),
            )
                .into_response()
        }
    }
}

async fn parse_community_avatar_file(
    mut multipart: Multipart,
) -> Result<Option<crate::application::communities::CommunityAvatarUpload>, Response> {
    use crate::application::communities::CommunityAvatarUpload;

    while let Some(field) = multipart.next_field().await.map_err(avatar_multipart_bad)? {
        let Some(name) = field.name().map(str::to_string) else {
            continue;
        };
        if name != "file" {
            continue;
        }
        let content_type = field
            .content_type()
            .map(str::to_string)
            .unwrap_or_default();
        let bytes = field.bytes().await.map_err(avatar_multipart_bad)?;
        return Ok(Some(CommunityAvatarUpload {
            content_type,
            bytes: bytes.to_vec(),
        }));
    }
    Ok(None)
}

fn avatar_multipart_bad(e: axum::extract::multipart::MultipartError) -> Response {
    tracing::warn!(error = %e, "community avatar multipart parse failed");
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({
            "error": "Выберите файл изображения (JPEG, PNG или WebP, до 2 МБ)."
        })),
    )
        .into_response()
}
