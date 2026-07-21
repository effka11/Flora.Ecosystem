//! HTTP `/api/music/*` — Фаза 1. Auth: `Extension<CurrentUser>` от flora-social.

mod byte_range;
mod uploads;

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Extension, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use uuid::Uuid;

use crate::application::artists::{ArtistError, ArtistService};
use crate::application::flow::FlowService;
use crate::application::genres::GenreService;
use crate::application::playlists::{CreatePlaylistError, DeletePlaylistError, PlaylistService};
use crate::application::tracks::TrackService;
use crate::application::upload::UploadService;
use crate::http::byte_range::parse_single_bytes_range;
use flora_music_contracts::CreateMusicPlaylistBody;

/// ~77 MiB — паритет с C# RequestSizeLimit (70 audio + 5 cover + buffer).
const MUSIC_BODY_LIMIT: usize = 77 * 1024 * 1024;

#[derive(Clone)]
pub struct MusicState {
    pub tracks: Arc<TrackService>,
    pub playlists: Arc<PlaylistService>,
    pub genres: Arc<GenreService>,
    pub artists: Arc<ArtistService>,
    pub flow: Arc<FlowService>,
    pub uploads: Arc<UploadService>,
}

/// Пользователь из JWT (внедряет flora-social middleware).
#[derive(Clone, Copy, Debug)]
pub struct CurrentUser(pub Uuid);

pub fn router(state: MusicState) -> Router {
    Router::new()
        .route("/api/music/genres", get(get_genres))
        .route("/api/music/genres/{genre_id}", get(get_genre_page))
        .route("/api/music/tracks/library", get(get_library))
        .route(
            "/api/music/tracks/platform",
            get(get_platform).post(uploads::upload_platform),
        )
        .route("/api/music/tracks/self", post(uploads::upload_personal))
        .route("/api/music/flow", get(get_flow))
        .route(
            "/api/music/playlists",
            get(get_playlists).post(create_playlist),
        )
        .route(
            "/api/music/playlists/{playlist_id}",
            get(get_playlist).delete(delete_playlist),
        )
        .route(
            "/api/music/artists",
            get(get_artists).post(uploads::create_artist),
        )
        .route("/api/music/artists/search", get(search_artists))
        .route("/api/music/artists/{artist_uuid}", get(get_artist))
        .route(
            "/api/music/artists/{artist_uuid}/cover",
            get(get_artist_cover),
        )
        .route(
            "/api/music/artists/{artist_uuid}/tracks",
            get(get_artist_tracks),
        )
        .route("/api/music/tracks/{track_uuid}/audio", get(get_track_audio))
        .route("/api/music/tracks/{track_uuid}/cover", get(get_track_cover))
        .route("/api/music/tracks/{track_uuid}", delete(delete_track))
        .route(
            "/api/music/tracks/{track_uuid}/favorite",
            post(add_favorite).delete(remove_favorite),
        )
        .route(
            "/api/music/tracks/{track_uuid}/not-interested",
            post(dismiss_track).delete(undismiss_track),
        )
        .layer(DefaultBodyLimit::max(MUSIC_BODY_LIMIT))
        .with_state(state)
}

/// §User Controls (FIRA-M): «не интересно» — трек больше не попадает в Поток.
async fn dismiss_track(
    State(state): State<MusicState>,
    Extension(user): Extension<CurrentUser>,
    Path(track_uuid): Path<Uuid>,
) -> Response {
    match state.flow.dismiss_track(user.0, track_uuid).await {
        Ok(true) => Json(serde_json::json!({ "notInterested": true })).into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Трек не найден." })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

async fn undismiss_track(
    State(state): State<MusicState>,
    Extension(user): Extension<CurrentUser>,
    Path(track_uuid): Path<Uuid>,
) -> Response {
    match state.flow.undismiss_track(user.0, track_uuid).await {
        Ok(_) => Json(serde_json::json!({ "notInterested": false })).into_response(),
        Err(e) => internal(e),
    }
}

async fn get_library(
    State(state): State<MusicState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    match state.tracks.list_library(user.0).await {
        Ok(tracks) => Json(tracks).into_response(),
        Err(e) => internal(e),
    }
}

async fn get_platform(
    State(state): State<MusicState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    match state.tracks.list_platform(user.0).await {
        Ok(tracks) => Json(tracks).into_response(),
        Err(e) => internal(e),
    }
}

async fn get_genres(
    State(state): State<MusicState>,
    Extension(_user): Extension<CurrentUser>,
) -> Response {
    match state.genres.catalog().await {
        Ok(catalog) => Json(catalog).into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenrePageQuery {
    subgenre_id: Option<String>,
}

async fn get_genre_page(
    State(state): State<MusicState>,
    Extension(user): Extension<CurrentUser>,
    Path(genre_id): Path<String>,
    Query(q): Query<GenrePageQuery>,
) -> Response {
    match state
        .genres
        .page(user.0, &genre_id, q.subgenre_id.as_deref())
        .await
    {
        Ok(Some(page)) => Json(page).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Жанр не найден." })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

async fn get_playlists(
    State(state): State<MusicState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    match state.playlists.list(user.0).await {
        Ok(list) => Json(list).into_response(),
        Err(e) => internal(e),
    }
}

async fn get_playlist(
    State(state): State<MusicState>,
    Extension(user): Extension<CurrentUser>,
    Path(playlist_id): Path<String>,
) -> Response {
    match state.playlists.get(user.0, &playlist_id).await {
        Ok(Some(detail)) => Json(detail).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Плейлист не найден." })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
struct ArtistsQuery {
    #[serde(default = "default_artists_take")]
    take: i32,
}

fn default_artists_take() -> i32 {
    20
}

async fn get_artists(
    State(state): State<MusicState>,
    Extension(_user): Extension<CurrentUser>,
    Query(q): Query<ArtistsQuery>,
) -> Response {
    match state.artists.list_featured(q.take).await {
        Ok(list) => Json(list).into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
struct SearchArtistsQuery {
    q: Option<String>,
    #[serde(default = "default_search_limit")]
    limit: i32,
}

fn default_search_limit() -> i32 {
    10
}

async fn search_artists(
    State(state): State<MusicState>,
    Extension(_user): Extension<CurrentUser>,
    Query(q): Query<SearchArtistsQuery>,
) -> Response {
    match state
        .artists
        .search(q.q.as_deref().unwrap_or(""), q.limit)
        .await
    {
        Ok(list) => Json(list).into_response(),
        Err(ArtistError::BadRequest(msg)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(ArtistError::Db(e)) => internal(e),
    }
}

async fn get_artist(
    State(state): State<MusicState>,
    Extension(_user): Extension<CurrentUser>,
    Path(artist_uuid): Path<Uuid>,
) -> Response {
    match state.artists.get(artist_uuid).await {
        Ok(Some(detail)) => Json(detail).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Исполнитель не найден." })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

async fn get_artist_cover(
    State(state): State<MusicState>,
    Extension(_user): Extension<CurrentUser>,
    Path(artist_uuid): Path<Uuid>,
) -> Response {
    match state.artists.get_cover(artist_uuid).await {
        Ok(Some(blob)) => media_response(blob.data, &blob.content_type),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Обложка не найдена." })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtistTracksQuery {
    #[serde(default = "default_page")]
    page: i32,
    #[serde(default = "default_page_size")]
    page_size: i32,
}

fn default_page() -> i32 {
    1
}

fn default_page_size() -> i32 {
    50
}

async fn get_artist_tracks(
    State(state): State<MusicState>,
    Extension(user): Extension<CurrentUser>,
    Path(artist_uuid): Path<Uuid>,
    Query(q): Query<ArtistTracksQuery>,
) -> Response {
    match state
        .artists
        .list_tracks(artist_uuid, user.0, q.page, q.page_size)
        .await
    {
        Ok(Some(page)) => Json(page).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Исполнитель не найден." })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlowQuery {
    #[serde(default = "default_flow_take")]
    take: i32,
    #[serde(default)]
    exclude: Vec<Uuid>,
    genre_id: Option<String>,
    subgenre_id: Option<String>,
}

fn default_flow_take() -> i32 {
    20
}

async fn get_flow(
    State(state): State<MusicState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<FlowQuery>,
) -> Response {
    match state
        .flow
        .get_wave(
            user.0,
            q.take,
            &q.exclude,
            q.genre_id.as_deref(),
            q.subgenre_id.as_deref(),
        )
        .await
    {
        Ok(wave) => Json(wave).into_response(),
        Err(e) => internal(e),
    }
}

async fn add_favorite(
    State(state): State<MusicState>,
    Extension(user): Extension<CurrentUser>,
    Path(track_uuid): Path<Uuid>,
) -> Response {
    match state.playlists.add_favorite(user.0, track_uuid).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Трек не найден." })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

async fn remove_favorite(
    State(state): State<MusicState>,
    Extension(user): Extension<CurrentUser>,
    Path(track_uuid): Path<Uuid>,
) -> Response {
    match state.playlists.remove_favorite(user.0, track_uuid).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Трек не в избранном." })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

async fn create_playlist(
    State(state): State<MusicState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<CreateMusicPlaylistBody>,
) -> Response {
    match state.playlists.create(user.0, body.title.as_deref()).await {
        Ok(dto) => Json(dto).into_response(),
        Err(CreatePlaylistError::Validation(msg)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response(),
        Err(CreatePlaylistError::Db(e)) => internal(e),
    }
}

async fn delete_playlist(
    State(state): State<MusicState>,
    Extension(user): Extension<CurrentUser>,
    Path(playlist_id): Path<String>,
) -> Response {
    match state.playlists.delete(user.0, &playlist_id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(DeletePlaylistError::Forbidden) => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Системный плейлист нельзя удалить." })),
        )
            .into_response(),
        Err(DeletePlaylistError::NotFound) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Плейлист не найден." })),
        )
            .into_response(),
        Err(DeletePlaylistError::Db(e)) => internal(e),
    }
}

async fn delete_track(
    State(state): State<MusicState>,
    Extension(user): Extension<CurrentUser>,
    Path(track_uuid): Path<Uuid>,
) -> Response {
    match state.tracks.delete(user.0, track_uuid).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Трек не найден." })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

async fn get_track_audio(
    State(state): State<MusicState>,
    Extension(user): Extension<CurrentUser>,
    Path(track_uuid): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    match state.tracks.get_audio(user.0, track_uuid).await {
        Ok(Some(blob)) => ranged_media_response(blob.data, &blob.content_type, &headers),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Трек не найден." })),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

async fn get_track_cover(
    State(state): State<MusicState>,
    Extension(user): Extension<CurrentUser>,
    Path(track_uuid): Path<Uuid>,
) -> Response {
    match state.tracks.get_cover(user.0, track_uuid).await {
        Ok(Some(blob)) => media_response(blob.data, &blob.content_type),
        // C#: NotFound() без тела
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => internal(e),
    }
}

fn media_response(data: Vec<u8>, content_type: &str) -> Response {
    let mut res = Response::new(Body::from(data));
    *res.status_mut() = StatusCode::OK;
    if let Ok(v) = HeaderValue::from_str(content_type) {
        res.headers_mut().insert(header::CONTENT_TYPE, v);
    }
    res
}

/// Паритет с `File(..., enableRangeProcessing: true)`.
fn ranged_media_response(data: Vec<u8>, content_type: &str, headers: &HeaderMap) -> Response {
    let total = data.len() as u64;
    let range_hdr = headers.get(header::RANGE).and_then(|v| v.to_str().ok());

    match parse_single_bytes_range(range_hdr, total) {
        Ok(None) => {
            let mut res = media_response(data, content_type);
            res.headers_mut()
                .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            res
        }
        Ok(Some(r)) => {
            let start = r.start as usize;
            let end_excl = (r.end as usize) + 1;
            let slice = data[start..end_excl].to_vec();
            let mut res = Response::new(Body::from(slice));
            *res.status_mut() = StatusCode::PARTIAL_CONTENT;
            if let Ok(v) = HeaderValue::from_str(content_type) {
                res.headers_mut().insert(header::CONTENT_TYPE, v);
            }
            res.headers_mut()
                .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            let content_range = format!("bytes {}-{}/{}", r.start, r.end, total);
            if let Ok(v) = HeaderValue::from_str(&content_range) {
                res.headers_mut().insert(header::CONTENT_RANGE, v);
            }
            res
        }
        Err(()) => {
            let mut res = Response::new(Body::empty());
            *res.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
            res.headers_mut()
                .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            let content_range = format!("bytes */{total}");
            if let Ok(v) = HeaderValue::from_str(&content_range) {
                res.headers_mut().insert(header::CONTENT_RANGE, v);
            }
            res
        }
    }
}

fn internal(err: sqlx::Error) -> Response {
    tracing::error!(error = %err, "music query failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": "Внутренняя ошибка сервера." })),
    )
        .into_response()
}
