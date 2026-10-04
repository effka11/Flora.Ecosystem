use std::sync::Arc;

use flora_music_contracts::{
    MusicGenreCatalogDto, MusicGenreCollectionDto, MusicGenreDto, MusicGenrePageDto,
    MusicSubgenreDto,
};
use uuid::Uuid;

use crate::application::tracks::TrackService;
use crate::domain::genre_catalog;
use crate::infrastructure::MusicRepo;
use crate::infrastructure::repo::TrackListRow;

pub struct GenreService {
    repo: Arc<MusicRepo>,
    tracks: Arc<TrackService>,
}

impl GenreService {
    pub fn new(repo: Arc<MusicRepo>, tracks: Arc<TrackService>) -> Self {
        Self { repo, tracks }
    }

    pub async fn catalog(&self) -> Result<MusicGenreCatalogDto, sqlx::Error> {
        let mut genres = Vec::with_capacity(genre_catalog::ENTRIES.len());
        for entry in genre_catalog::ENTRIES {
            let mut subgenres = Vec::with_capacity(entry.subgenres.len());
            for sub in entry.subgenres {
                let count = self
                    .repo
                    .count_platform_by_scope(Some(entry.id), Some(sub.id))
                    .await? as i32;
                subgenres.push(MusicSubgenreDto {
                    id: sub.id.to_string(),
                    title: sub.title.to_string(),
                    description: None,
                    track_count: count,
                });
            }
            let genre_count = self
                .repo
                .count_platform_by_scope(Some(entry.id), None)
                .await? as i32;
            genres.push(MusicGenreDto {
                id: entry.id.to_string(),
                title: entry.title.to_string(),
                description: None,
                track_count: genre_count,
                subgenres,
            });
        }
        Ok(MusicGenreCatalogDto { genres })
    }

    pub async fn page(
        &self,
        user: Uuid,
        genre_id: &str,
        subgenre_id: Option<&str>,
    ) -> Result<Option<MusicGenrePageDto>, sqlx::Error> {
        let Some(genre_entry) = genre_catalog::find_genre(genre_id) else {
            return Ok(None);
        };
        if let Some(sub) = subgenre_id
            && genre_catalog::find_subgenre(genre_id, sub).is_none()
        {
            return Ok(None);
        }

        let scope_sub = subgenre_id.filter(|s| !s.is_empty());
        let mut subgenres = Vec::with_capacity(genre_entry.subgenres.len());
        for sub in genre_entry.subgenres {
            let count = self
                .repo
                .count_platform_by_scope(Some(genre_entry.id), Some(sub.id))
                .await? as i32;
            subgenres.push(MusicSubgenreDto {
                id: sub.id.to_string(),
                title: sub.title.to_string(),
                description: None,
                track_count: count,
            });
        }
        let genre_track_count = self
            .repo
            .count_platform_by_scope(Some(genre_entry.id), None)
            .await? as i32;
        let genre = MusicGenreDto {
            id: genre_entry.id.to_string(),
            title: genre_entry.title.to_string(),
            description: None,
            track_count: genre_track_count,
            subgenres,
        };

        let active_subgenre = if let Some(sub_id) = scope_sub {
            let active = genre_catalog::find_subgenre(genre_id, sub_id).expect("checked");
            let count = self
                .repo
                .count_platform_by_scope(Some(genre_entry.id), Some(sub_id))
                .await? as i32;
            Some(MusicSubgenreDto {
                id: active.id.to_string(),
                title: active.title.to_string(),
                description: None,
                track_count: count,
            })
        } else {
            None
        };

        let popular = self
            .repo
            .list_popular_platform_by_scope(Some(genre_entry.id), scope_sub, 12)
            .await?;
        let new_tracks = self
            .repo
            .list_new_platform_by_scope(Some(genre_entry.id), scope_sub, 12)
            .await?;

        let collections = vec![
            self.build_collection("popular", "Популярное", popular, user)
                .await?,
            self.build_collection("new", "Новое", new_tracks, user)
                .await?,
        ];

        Ok(Some(MusicGenrePageDto {
            genre,
            active_subgenre,
            collections,
        }))
    }

    async fn build_collection(
        &self,
        id: &str,
        title: &str,
        rows: Vec<TrackListRow>,
        _user: Uuid,
    ) -> Result<MusicGenreCollectionDto, sqlx::Error> {
        let tracks = self.tracks.map_tracks(force_platform_scope(rows)).await?;
        Ok(MusicGenreCollectionDto {
            id: id.to_string(),
            title: title.to_string(),
            tracks,
        })
    }
}

fn force_platform_scope(mut rows: Vec<TrackListRow>) -> Vec<TrackListRow> {
    for r in &mut rows {
        r.scope = 1;
        r.tags = None;
    }
    rows
}
