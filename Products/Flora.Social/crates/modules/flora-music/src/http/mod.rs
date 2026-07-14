//! HTTP `/api/music/*` — read-GET срез Фазы 1. Auth: `Extension<CurrentUser>` от flora-social.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Extension, Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use uuid::Uuid;

use crate::application::artists::{ArtistError, ArtistService};
use crate::application::genres::GenreService;
use crate::application::playlists::PlaylistService;
use crate::application::tracks::TrackService;

#[derive(Clone)]
pub struct MusicState {
    pub tracks: Arc<TrackService>,
    pub playlists: Arc<PlaylistService>,
    pub genres: Arc<GenreService>,
    pub artists: Arc<ArtistService>,
}

/// Пользователь из JWT (внедряет flora-social middleware).
#[derive(Clone, Copy, Debug)]
pub struct CurrentUser(pub Uuid);

pub fn router(state: MusicState) -> Router {
    Router::new()
        .route("/api/music/genres", get(get_genres))
        .route("/api/music/genres/{genre_id}", get(get_genre_page))
        .route("/api/music/tracks/library", get(get_library))
        .route("/api/music/tracks/platform", get(get_platform))
        .route("/api/music/playlists", get(get_playlists))
        .route("/api/music/playlists/{playlist_id}", get(get_playlist))
        .route("/api/music/artists", get(get_artists))
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
        .with_state(state)
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

fn media_response(data: Vec<u8>, content_type: &str) -> Response {
    let mut res = Response::new(Body::from(data));
    *res.status_mut() = StatusCode::OK;
    if let Ok(v) = HeaderValue::from_str(content_type) {
        res.headers_mut().insert(header::CONTENT_TYPE, v);
    }
    res
}

fn internal(err: sqlx::Error) -> Response {
    tracing::error!(error = %err, "music query failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": "Внутренняя ошибка сервера." })),
    )
        .into_response()
}
