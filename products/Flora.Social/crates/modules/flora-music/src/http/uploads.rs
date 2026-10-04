//! Multipart upload handlers — tracks/self|platform, artists create.

use axum::Json;
use axum::extract::{Extension, Multipart, State};
use axum::response::{IntoResponse, Response};

use crate::application::upload::UploadError;
use crate::http::{CurrentUser, MusicState};

pub async fn upload_personal(
    State(state): State<MusicState>,
    Extension(user): Extension<CurrentUser>,
    multipart: Multipart,
) -> Response {
    match parse_and_upload_personal(&state, user.0, multipart).await {
        Ok(dto) => Json(dto).into_response(),
        Err(e) => upload_err(e),
    }
}

pub async fn upload_platform(
    State(state): State<MusicState>,
    Extension(user): Extension<CurrentUser>,
    multipart: Multipart,
) -> Response {
    match parse_and_upload_platform(&state, user.0, multipart).await {
        Ok(dto) => Json(dto).into_response(),
        Err(e) => upload_err(e),
    }
}

pub async fn create_artist(
    State(state): State<MusicState>,
    Extension(user): Extension<CurrentUser>,
    multipart: Multipart,
) -> Response {
    match parse_and_create_artist(&state, user.0, multipart).await {
        Ok(dto) => Json(dto).into_response(),
        Err(e) => upload_err(e),
    }
}

fn upload_err(err: UploadError) -> Response {
    if let UploadError::Db(ref e) = err {
        tracing::error!(error = %e, "music upload failed");
    }
    let (status, msg) = err.status_and_message();
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

async fn parse_and_upload_personal(
    state: &MusicState,
    owner: uuid::Uuid,
    mut multipart: Multipart,
) -> Result<flora_music_contracts::UploadMusicTrackResultDto, UploadError> {
    let mut title = None;
    let mut artist = None;
    let mut artist_credits = None;
    let mut tags = None;
    let mut cover_color_id = None;
    let mut track_kind_id = None;
    let mut duration_ms = 0i32;
    let mut file_name = String::new();
    let mut content_type = String::new();
    let mut audio_bytes: Option<Vec<u8>> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| UploadError::BadRequest(e.to_string()))?
    {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "file" => {
                file_name = field.file_name().unwrap_or("audio.bin").to_string();
                content_type = field
                    .content_type()
                    .map(|m| m.to_string())
                    .unwrap_or_default();
                audio_bytes = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|e| UploadError::BadRequest(e.to_string()))?
                        .to_vec(),
                );
            }
            "title" => title = Some(field_text(field).await?),
            "artist" => artist = Some(field_text(field).await?),
            "artistCredits" => artist_credits = Some(field_text(field).await?),
            "tags" => tags = Some(field_text(field).await?),
            "coverColorId" => cover_color_id = Some(field_text(field).await?),
            "trackKindId" => track_kind_id = Some(field_text(field).await?),
            "durationMs" => {
                let t = field_text(field).await?;
                duration_ms = t.parse().unwrap_or(0);
            }
            _ => {
                let _ = field.bytes().await;
            }
        }
    }

    let Some(audio_bytes) = audio_bytes.filter(|b| !b.is_empty()) else {
        return Err(UploadError::BadRequest("Файл пуст.".into()));
    };

    state
        .uploads
        .upload_personal(
            owner,
            title.as_deref(),
            artist.as_deref(),
            artist_credits.as_deref(),
            tags.as_deref(),
            cover_color_id.as_deref(),
            track_kind_id.as_deref(),
            duration_ms,
            &file_name,
            &content_type,
            audio_bytes,
        )
        .await
}

async fn parse_and_upload_platform(
    state: &MusicState,
    owner: uuid::Uuid,
    mut multipart: Multipart,
) -> Result<flora_music_contracts::UploadMusicTrackResultDto, UploadError> {
    let mut title = None;
    let mut artist = None;
    let mut artist_credits = None;
    let mut genre_id = None;
    let mut license_id = None;
    let mut terms_accepted = false;
    let mut duration_ms = 0i32;
    let mut file_name = String::new();
    let mut content_type = String::new();
    let mut audio_bytes: Option<Vec<u8>> = None;
    let mut cover_ct = None;
    let mut cover_bytes = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| UploadError::BadRequest(e.to_string()))?
    {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "file" => {
                file_name = field.file_name().unwrap_or("audio.bin").to_string();
                content_type = field
                    .content_type()
                    .map(|m| m.to_string())
                    .unwrap_or_default();
                audio_bytes = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|e| UploadError::BadRequest(e.to_string()))?
                        .to_vec(),
                );
            }
            "cover" => {
                cover_ct = field.content_type().map(|m| m.to_string());
                let bytes = field
                    .bytes()
                    .await
                    .map_err(|e| UploadError::BadRequest(e.to_string()))?
                    .to_vec();
                if !bytes.is_empty() {
                    cover_bytes = Some(bytes);
                }
            }
            "title" => title = Some(field_text(field).await?),
            "artist" => artist = Some(field_text(field).await?),
            "artistCredits" => artist_credits = Some(field_text(field).await?),
            "genreId" => genre_id = Some(field_text(field).await?),
            "licenseId" => license_id = Some(field_text(field).await?),
            "termsAccepted" => {
                let t = field_text(field).await?;
                terms_accepted = t.eq_ignore_ascii_case("true") || t == "1";
            }
            "durationMs" => {
                let t = field_text(field).await?;
                duration_ms = t.parse().unwrap_or(0);
            }
            _ => {
                let _ = field.bytes().await;
            }
        }
    }

    let Some(audio_bytes) = audio_bytes.filter(|b| !b.is_empty()) else {
        return Err(UploadError::BadRequest("Файл пуст.".into()));
    };

    state
        .uploads
        .upload_platform(
            owner,
            title.as_deref(),
            artist.as_deref(),
            artist_credits.as_deref(),
            genre_id.as_deref(),
            license_id.as_deref(),
            terms_accepted,
            duration_ms,
            &file_name,
            &content_type,
            audio_bytes,
            cover_ct.as_deref(),
            cover_bytes,
        )
        .await
}

async fn parse_and_create_artist(
    state: &MusicState,
    actor: uuid::Uuid,
    mut multipart: Multipart,
) -> Result<flora_music_contracts::MusicArtistSummaryDto, UploadError> {
    let mut display_name = String::new();
    let mut link = false;
    let mut cover_ct = None;
    let mut cover_bytes = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| UploadError::BadRequest(e.to_string()))?
    {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "displayName" => display_name = field_text(field).await?,
            "linkToMyProfile" => {
                let t = field_text(field).await?;
                link = t.eq_ignore_ascii_case("true") || t == "1";
            }
            "cover" => {
                cover_ct = field.content_type().map(|m| m.to_string());
                let bytes = field
                    .bytes()
                    .await
                    .map_err(|e| UploadError::BadRequest(e.to_string()))?
                    .to_vec();
                if !bytes.is_empty() {
                    cover_bytes = Some(bytes);
                }
            }
            _ => {
                let _ = field.bytes().await;
            }
        }
    }

    state
        .uploads
        .create_artist(actor, &display_name, link, cover_bytes, cover_ct.as_deref())
        .await
}

async fn field_text(field: axum::extract::multipart::Field<'_>) -> Result<String, UploadError> {
    field
        .text()
        .await
        .map_err(|e| UploadError::BadRequest(e.to_string()))
}
