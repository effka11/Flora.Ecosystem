//! Контракты модуля Music — wire DTO без бизнес-логики (next-architecture.md §2.2).
//!
//! Формы совпадают с anonymous Map* в `MusicController` / `MusicTrackResponseHelpers`
//! (string scope/kind/joinerBefore; null omit как WhenWritingNull).

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrackArtistCreditDto {
    pub artist_uuid: Uuid,
    pub display_name: String,
    pub joiner_before: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MusicTrackDto {
    pub track_uuid: Uuid,
    pub scope: String,
    pub title: String,
    pub artist_display: String,
    pub artist_credits: Vec<TrackArtistCreditDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub genre_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_color_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_kind_id: Option<String>,
    pub has_cover_image: bool,
    pub duration_ms: i32,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MusicPlatformTrackDto {
    pub track_uuid: Uuid,
    pub title: String,
    pub artist_display: String,
    pub artist_credits: Vec<TrackArtistCreditDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub genre_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_color_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_kind_id: Option<String>,
    pub has_cover_image: bool,
    pub duration_ms: i32,
    pub created_at: String,
    pub published_at: String,
    pub is_owned_by_current_user: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MusicSubgenreDto {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub track_count: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MusicGenreDto {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub track_count: i32,
    pub subgenres: Vec<MusicSubgenreDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MusicGenreCollectionDto {
    pub id: String,
    pub title: String,
    pub tracks: Vec<MusicTrackDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MusicGenreCatalogDto {
    pub genres: Vec<MusicGenreDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MusicGenrePageDto {
    pub genre: MusicGenreDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_subgenre: Option<MusicSubgenreDto>,
    pub collections: Vec<MusicGenreCollectionDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MusicPlaylistSummaryDto {
    pub id: String,
    pub title: String,
    pub track_count: i32,
    pub kind: String,
    pub variant: String,
    pub can_delete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_color_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MusicPlaylistDetailDto {
    pub id: String,
    pub title: String,
    pub track_count: i32,
    pub kind: String,
    pub variant: String,
    pub can_delete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_color_id: Option<String>,
    pub tracks: Vec<MusicTrackDto>,
}

pub const SYSTEM_PLAYLIST_UPLOADED_PERSONAL: &str = "uploaded-personal";
pub const SYSTEM_PLAYLIST_UPLOADED_PLATFORM: &str = "uploaded-platform";

pub fn is_system_playlist_id(id: &str) -> bool {
    id == SYSTEM_PLAYLIST_UPLOADED_PERSONAL || id == SYSTEM_PLAYLIST_UPLOADED_PLATFORM
}

/// Wire MapArtistSummary / MapArtistDetail (MusicArtistControllerHelpers).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MusicArtistSummaryDto {
    pub artist_uuid: Uuid,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_user_uuid: Option<Uuid>,
    pub created_by_user_uuid: Uuid,
    pub tracks_count: i32,
    pub has_cover_image: bool,
}

pub type MusicArtistDetailDto = MusicArtistSummaryDto;

/// GET /api/music/artists/{uuid}/tracks — paged envelope.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PagedMusicTracksDto {
    pub tracks: Vec<MusicTrackDto>,
    pub total_count: i32,
    pub page: i32,
    pub page_size: i32,
}

/// POST /api/music/playlists — body (MusicController.CreateMusicPlaylistBody).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateMusicPlaylistBody {
    pub title: Option<String>,
}

/// POST /api/music/playlists — result (CreateMusicPlaylistResultDto).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateMusicPlaylistResultDto {
    pub playlist_id: String,
    pub title: String,
}

/// GET /api/music/flow — wave envelope (MapFlowTrack items = MusicPlatformTrackDto).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MusicFlowWaveDto {
    pub tracks: Vec<MusicPlatformTrackDto>,
    pub generated_at: String,
    pub expires_at: String,
}

/// Wire alias: MapFlowTrack ≡ MapPlatformTrack.
pub type MusicFlowTrackDto = MusicPlatformTrackDto;

/// POST /api/music/tracks/self|platform success.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadMusicTrackResultDto {
    pub track_uuid: Uuid,
    pub title: String,
    pub artist_display: String,
}
