//! Модуль Music. Перенос — Фаза 1 (next-architecture.md §6); владелец — таблица §6.0.
//!
//! Prep без cutover: HTTP монтируется продуктом только при `Music:ServeNative=true`.

pub mod application;
pub mod domain;
pub mod http;
pub mod infrastructure;

use std::sync::Arc;

use sqlx::PgPool;

use crate::application::artists::ArtistService;
use crate::application::genres::GenreService;
use crate::application::playlists::PlaylistService;
use crate::application::tracks::TrackService;
use crate::http::MusicState;
use crate::infrastructure::MusicRepo;

/// Собранный модуль: роутер с state (без JWT — слой навешивает flora-social).
pub struct MusicModule {
    pub router: axum::Router,
}

/// Пустой роутер (ServeNative=false / нет пула) — gateway-fallback отдаёт в .NET.
pub fn router() -> axum::Router {
    axum::Router::new()
}

pub fn compose(pool: PgPool) -> MusicModule {
    let repo = Arc::new(MusicRepo::new(pool));
    let tracks = Arc::new(TrackService::new(repo.clone()));
    let playlists = Arc::new(PlaylistService::new(repo.clone(), tracks.clone()));
    let genres = Arc::new(GenreService::new(repo.clone(), tracks.clone()));
    let artists = Arc::new(ArtistService::new(repo, tracks.clone()));
    let state = MusicState {
        tracks,
        playlists,
        genres,
        artists,
    };
    MusicModule {
        router: http::router(state),
    }
}

#[cfg(test)]
mod wire_tests {
    use flora_music_contracts::MusicTrackDto;
    use uuid::Uuid;

    #[test]
    fn track_omits_null_optionals() {
        let track = MusicTrackDto {
            track_uuid: Uuid::nil(),
            scope: "personal".into(),
            title: "t".into(),
            artist_display: "a".into(),
            artist_credits: vec![],
            tags: None,
            genre_id: None,
            license_id: None,
            cover_color_id: None,
            track_kind_id: None,
            has_cover_image: false,
            duration_ms: 1,
            created_at: "2026-06-12T10:00:00.000Z".into(),
            published_at: None,
        };
        let v = serde_json::to_value(&track).unwrap();
        assert!(v.get("tags").is_none());
        assert!(v.get("publishedAt").is_none());
        assert_eq!(v["scope"], "personal");
    }
}
