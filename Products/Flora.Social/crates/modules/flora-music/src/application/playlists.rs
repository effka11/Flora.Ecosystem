use std::sync::Arc;

use chrono::Utc;
use flora_music_contracts::{
    CreateMusicPlaylistResultDto, MusicPlaylistDetailDto, MusicPlaylistSummaryDto,
    SYSTEM_PLAYLIST_UPLOADED_PERSONAL, SYSTEM_PLAYLIST_UPLOADED_PLATFORM, is_system_playlist_id,
};
use flora_shared::flora_uuid::new_uuid;
use uuid::Uuid;

use crate::application::tracks::TrackService;
use crate::infrastructure::MusicRepo;

pub struct PlaylistService {
    repo: Arc<MusicRepo>,
    tracks: Arc<TrackService>,
}

pub enum DeletePlaylistError {
    Forbidden,
    NotFound,
    Db(sqlx::Error),
}

pub enum CreatePlaylistError {
    Validation(String),
    Db(sqlx::Error),
}

impl PlaylistService {
    pub fn new(repo: Arc<MusicRepo>, tracks: Arc<TrackService>) -> Self {
        Self { repo, tracks }
    }

    pub async fn list(&self, user: Uuid) -> Result<Vec<MusicPlaylistSummaryDto>, sqlx::Error> {
        let mut out = Vec::new();
        let personal = self.repo.count_personal(user).await?;
        if personal > 0 {
            out.push(MusicPlaylistSummaryDto {
                id: SYSTEM_PLAYLIST_UPLOADED_PERSONAL.to_string(),
                title: "Загруженное для себя".to_string(),
                track_count: personal as i32,
                kind: "system".to_string(),
                variant: "uploaded-personal".to_string(),
                can_delete: false,
                cover_color_id: None,
            });
        }
        let platform = self.repo.count_platform_owned(user).await?;
        if platform > 0 {
            out.push(MusicPlaylistSummaryDto {
                id: SYSTEM_PLAYLIST_UPLOADED_PLATFORM.to_string(),
                title: "Загруженное на площадку".to_string(),
                track_count: platform as i32,
                kind: "system".to_string(),
                variant: "uploaded-platform".to_string(),
                can_delete: false,
                cover_color_id: None,
            });
        }
        for row in self.repo.list_user_playlists(user).await? {
            out.push(MusicPlaylistSummaryDto {
                id: row.playlist_uuid.to_string(),
                title: row.title,
                track_count: row.track_count as i32,
                kind: "user".to_string(),
                variant: "user".to_string(),
                can_delete: true,
                cover_color_id: row.cover_color_id,
            });
        }
        Ok(out)
    }

    pub async fn get(
        &self,
        user: Uuid,
        playlist_id: &str,
    ) -> Result<Option<MusicPlaylistDetailDto>, sqlx::Error> {
        if is_system_playlist_id(playlist_id) {
            return self.get_system(user, playlist_id).await;
        }
        let Ok(playlist_uuid) = Uuid::parse_str(playlist_id) else {
            return Ok(None);
        };
        let Some(playlist) = self.repo.find_user_playlist(user, playlist_uuid).await? else {
            return Ok(None);
        };
        let rows = self.repo.list_playlist_tracks(playlist_uuid).await?;
        let tracks = self.tracks.map_tracks(rows).await?;
        Ok(Some(MusicPlaylistDetailDto {
            id: playlist.playlist_uuid.to_string(),
            title: playlist.title,
            track_count: tracks.len() as i32,
            kind: "user".to_string(),
            variant: "user".to_string(),
            can_delete: true,
            cover_color_id: playlist.cover_color_id,
            tracks,
        }))
    }

    async fn get_system(
        &self,
        user: Uuid,
        playlist_id: &str,
    ) -> Result<Option<MusicPlaylistDetailDto>, sqlx::Error> {
        let (title, variant, rows) = if playlist_id == SYSTEM_PLAYLIST_UPLOADED_PERSONAL {
            (
                "Загруженное для себя",
                "uploaded-personal",
                self.repo.list_personal_tracks(user).await?,
            )
        } else if playlist_id == SYSTEM_PLAYLIST_UPLOADED_PLATFORM {
            (
                "Загруженное на площадку",
                "uploaded-platform",
                self.repo.list_platform_owned_tracks(user).await?,
            )
        } else {
            return Ok(None);
        };
        let tracks = self.tracks.map_tracks(rows).await?;
        Ok(Some(MusicPlaylistDetailDto {
            id: playlist_id.to_string(),
            title: title.to_string(),
            track_count: tracks.len() as i32,
            kind: "system".to_string(),
            variant: variant.to_string(),
            can_delete: false,
            cover_color_id: None,
            tracks,
        }))
    }

    pub async fn add_favorite(&self, user: Uuid, track: Uuid) -> Result<bool, sqlx::Error> {
        if !self.repo.is_track_owned(user, track).await? {
            return Ok(false);
        }
        if !self.repo.is_favorite(user, track).await? {
            self.repo.insert_favorite(user, track, Utc::now()).await?;
        }
        Ok(true)
    }

    pub async fn remove_favorite(&self, user: Uuid, track: Uuid) -> Result<bool, sqlx::Error> {
        self.repo.delete_favorite(user, track).await
    }

    pub async fn create(
        &self,
        user: Uuid,
        title: Option<&str>,
    ) -> Result<CreateMusicPlaylistResultDto, CreatePlaylistError> {
        let normalized = title.unwrap_or("").trim();
        if normalized.is_empty() {
            return Err(CreatePlaylistError::Validation(
                "Введите название плейлиста.".into(),
            ));
        }
        if normalized.chars().count() > 200 {
            return Err(CreatePlaylistError::Validation(
                "Название плейлиста слишком длинное.".into(),
            ));
        }
        let id = new_uuid();
        self.repo
            .insert_playlist(id, user, normalized, Utc::now())
            .await
            .map_err(CreatePlaylistError::Db)?;
        Ok(CreateMusicPlaylistResultDto {
            playlist_id: id.to_string(),
            title: normalized.to_string(),
        })
    }

    pub async fn delete(&self, user: Uuid, playlist_id: &str) -> Result<(), DeletePlaylistError> {
        if is_system_playlist_id(playlist_id) {
            return Err(DeletePlaylistError::Forbidden);
        }
        let Ok(uuid) = Uuid::parse_str(playlist_id) else {
            return Err(DeletePlaylistError::NotFound);
        };
        match self.repo.delete_user_playlist(user, uuid).await {
            Ok(true) => Ok(()),
            Ok(false) => Err(DeletePlaylistError::NotFound),
            Err(e) => Err(DeletePlaylistError::Db(e)),
        }
    }
}
