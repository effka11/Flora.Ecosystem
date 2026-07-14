//! HTTP `/api/music/*` — read-GET срез Фазы 1. Auth: `Extension<CurrentUser>` от flora-social.

use std::sync::Arc;

use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use uuid::Uuid;

use crate::application::genres::GenreService;
use crate::application::playlists::PlaylistService;
use crate::application::tracks::TrackService;

#[derive(Clone)]
pub struct MusicState {
    pub tracks: Arc<TrackService>,
    pub playlists: Arc<PlaylistService>,
    pub genres: Arc<GenreService>,
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

fn internal(err: sqlx::Error) -> Response {
    tracing::error!(error = %err, "music query failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": "Внутренняя ошибка сервера." })),
    )
        .into_response()
}
