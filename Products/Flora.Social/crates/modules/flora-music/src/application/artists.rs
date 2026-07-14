use std::sync::Arc;

use flora_music_contracts::{MusicArtistDetailDto, MusicArtistSummaryDto, PagedMusicTracksDto};
use uuid::Uuid;

use crate::application::tracks::TrackService;
use crate::domain::artist_name;
use crate::infrastructure::repo::{ArtistListRow, MediaBlobRow, MusicRepo};

pub struct ArtistService {
    repo: Arc<MusicRepo>,
    tracks: Arc<TrackService>,
}

#[derive(Debug)]
pub enum ArtistError {
    BadRequest(String),
    Db(sqlx::Error),
}

impl From<sqlx::Error> for ArtistError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(value)
    }
}

impl ArtistService {
    pub fn new(repo: Arc<MusicRepo>, tracks: Arc<TrackService>) -> Self {
        Self { repo, tracks }
    }

    pub async fn list_featured(
        &self,
        take: i32,
    ) -> Result<Vec<MusicArtistSummaryDto>, sqlx::Error> {
        let rows = self.repo.list_featured_artists(take).await?;
        Ok(rows.into_iter().map(map_summary).collect())
    }

    pub async fn search(
        &self,
        query: &str,
        limit: i32,
    ) -> Result<Vec<MusicArtistSummaryDto>, ArtistError> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Err(ArtistError::BadRequest("Запрос слишком короткий.".into()));
        }
        let normalized = artist_name::normalize(trimmed);
        if normalized.is_empty() {
            return Ok(Vec::new());
        }
        let rows = self
            .repo
            .search_artists(&normalized, trimmed.chars().count(), limit)
            .await?;
        Ok(rows.into_iter().map(map_summary).collect())
    }

    pub async fn get(
        &self,
        artist_uuid: Uuid,
    ) -> Result<Option<MusicArtistDetailDto>, sqlx::Error> {
        Ok(self.repo.find_artist(artist_uuid).await?.map(map_summary))
    }

    pub async fn get_cover(&self, artist_uuid: Uuid) -> Result<Option<MediaBlobRow>, sqlx::Error> {
        self.repo.find_artist_cover(artist_uuid).await
    }

    pub async fn list_tracks(
        &self,
        artist_uuid: Uuid,
        requester: Uuid,
        page: i32,
        page_size: i32,
    ) -> Result<Option<PagedMusicTracksDto>, sqlx::Error> {
        if self.repo.find_artist(artist_uuid).await?.is_none() {
            return Ok(None);
        }
        let safe_page = page.max(1);
        let safe_size = page_size.clamp(1, 100);
        let total = self
            .repo
            .count_artist_tracks_visible(artist_uuid, requester)
            .await?;
        let rows = self
            .repo
            .list_artist_tracks_paged(artist_uuid, requester, safe_page, safe_size)
            .await?;
        let tracks = self.tracks.map_tracks(rows).await?;
        Ok(Some(PagedMusicTracksDto {
            tracks,
            total_count: i32::try_from(total).unwrap_or(i32::MAX),
            page: safe_page,
            page_size: safe_size,
        }))
    }
}

fn map_summary(row: ArtistListRow) -> MusicArtistSummaryDto {
    MusicArtistSummaryDto {
        artist_uuid: row.artist_uuid,
        display_name: row.display_name,
        linked_user_uuid: row.linked_user_uuid,
        created_by_user_uuid: row.created_by_user_uuid,
        tracks_count: row.tracks_count,
        has_cover_image: row.has_cover_image,
    }
}
