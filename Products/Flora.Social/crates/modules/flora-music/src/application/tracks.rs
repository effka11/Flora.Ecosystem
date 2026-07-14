use std::collections::HashMap;
use std::sync::Arc;

use flora_music_contracts::{MusicPlatformTrackDto, MusicTrackDto, TrackArtistCreditDto};
use uuid::Uuid;

use crate::application::time::{format_utc, format_utc_opt};
use crate::infrastructure::repo::{
    CreditRow, MusicRepo, TrackListRow, joiner_to_wire, scope_to_wire,
};

pub struct TrackService {
    repo: Arc<MusicRepo>,
}

impl TrackService {
    pub fn new(repo: Arc<MusicRepo>) -> Self {
        Self { repo }
    }

    pub async fn list_library(&self, user: Uuid) -> Result<Vec<MusicTrackDto>, sqlx::Error> {
        let rows = self.repo.list_library(user).await?;
        self.map_tracks(rows).await
    }

    pub async fn list_platform(
        &self,
        user: Uuid,
    ) -> Result<Vec<MusicPlatformTrackDto>, sqlx::Error> {
        let rows = self.repo.list_platform_catalog().await?;
        let credits = self.load_credit_map(&rows).await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let track_credits = credits.get(&r.track_uuid).cloned().unwrap_or_default();
                MusicPlatformTrackDto {
                    track_uuid: r.track_uuid,
                    title: r.title,
                    artist_display: r.artist_display,
                    artist_credits: track_credits,
                    genre_id: r.genre_id,
                    license_id: r.license_id,
                    cover_color_id: r.cover_color_id,
                    track_kind_id: r.track_kind_id,
                    has_cover_image: r.has_cover_image,
                    duration_ms: r.duration_ms,
                    created_at: format_utc(r.created_at),
                    published_at: format_utc(
                        r.published_at
                            .expect("platform catalog requires published_at"),
                    ),
                    is_owned_by_current_user: r.owner_user_uuid == user,
                }
            })
            .collect())
    }

    pub async fn map_tracks(
        &self,
        rows: Vec<TrackListRow>,
    ) -> Result<Vec<MusicTrackDto>, sqlx::Error> {
        let credits = self.load_credit_map(&rows).await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let c = credits.get(&r.track_uuid).cloned().unwrap_or_default();
                map_track_row(r, c)
            })
            .collect())
    }

    async fn load_credit_map(
        &self,
        rows: &[TrackListRow],
    ) -> Result<HashMap<Uuid, Vec<TrackArtistCreditDto>>, sqlx::Error> {
        let ids: Vec<Uuid> = rows.iter().map(|r| r.track_uuid).collect();
        let credit_rows = self.repo.list_credits_for_tracks(&ids).await?;
        Ok(group_credits(credit_rows))
    }
}

pub fn map_track_row(r: TrackListRow, artist_credits: Vec<TrackArtistCreditDto>) -> MusicTrackDto {
    MusicTrackDto {
        track_uuid: r.track_uuid,
        scope: scope_to_wire(r.scope).to_string(),
        title: r.title,
        artist_display: r.artist_display,
        artist_credits,
        tags: r.tags,
        genre_id: r.genre_id,
        license_id: r.license_id,
        cover_color_id: r.cover_color_id,
        track_kind_id: r.track_kind_id,
        has_cover_image: r.has_cover_image,
        duration_ms: r.duration_ms,
        created_at: format_utc(r.created_at),
        published_at: format_utc_opt(r.published_at),
    }
}

fn group_credits(rows: Vec<CreditRow>) -> HashMap<Uuid, Vec<TrackArtistCreditDto>> {
    let mut map: HashMap<Uuid, Vec<TrackArtistCreditDto>> = HashMap::new();
    for c in rows {
        map.entry(c.track_uuid)
            .or_default()
            .push(TrackArtistCreditDto {
                artist_uuid: c.artist_uuid,
                display_name: c.display_name,
                joiner_before: joiner_to_wire(c.joiner_before).to_string(),
            });
    }
    map
}
