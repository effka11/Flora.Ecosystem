use std::collections::HashMap;
use std::sync::Arc;

use flora_music_contracts::{MusicPlatformTrackDto, MusicTrackDto, TrackArtistCreditDto};
use uuid::Uuid;

use crate::application::audio_search::AudioSearchHost;
use crate::application::time::{format_utc, format_utc_opt};
use crate::infrastructure::repo::{
    CreditRow, MediaBlobRow, MusicRepo, TrackListRow, joiner_to_wire, scope_to_wire,
};

pub struct TrackService {
    repo: Arc<MusicRepo>,
    audio: AudioSearchHost,
}

impl TrackService {
    pub fn new(repo: Arc<MusicRepo>, audio: AudioSearchHost) -> Self {
        Self { repo, audio }
    }

    /// Catalog-only FSA-A search. Bare `MusicTrackDto` list (no scores, no `{ items }`).
    pub async fn search(
        &self,
        q: &str,
        skip: i32,
        take: i32,
    ) -> Result<Vec<MusicTrackDto>, sqlx::Error> {
        let skip = skip.max(0) as usize;
        let take = take.clamp(1, 50) as usize;
        let ids = self.audio.search(q, skip, take).await;
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let rows = self.repo.list_catalog_tracks_by_uuids(&ids).await?;
        let dtos = self.map_tracks(rows).await?;
        let mut by_id: HashMap<Uuid, MusicTrackDto> =
            dtos.into_iter().map(|t| (t.track_uuid, t)).collect();
        Ok(ids.into_iter().filter_map(|id| by_id.remove(&id)).collect())
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

    /// MapFlowTrack / MapPlatformTrack wire.
    pub async fn map_platform_rows(
        &self,
        user: Uuid,
        rows: Vec<TrackListRow>,
    ) -> Result<Vec<MusicPlatformTrackDto>, sqlx::Error> {
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
                            .expect("flow/platform track requires published_at"),
                    ),
                    is_owned_by_current_user: r.owner_user_uuid == user,
                }
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

    pub async fn get_audio(
        &self,
        requester: Uuid,
        track_uuid: Uuid,
    ) -> Result<Option<MediaBlobRow>, sqlx::Error> {
        self.repo
            .find_track_audio_accessible(requester, track_uuid)
            .await
    }

    pub async fn get_cover(
        &self,
        requester: Uuid,
        track_uuid: Uuid,
    ) -> Result<Option<MediaBlobRow>, sqlx::Error> {
        self.repo
            .find_track_cover_accessible(requester, track_uuid)
            .await
    }

    pub async fn delete(&self, owner: Uuid, track_uuid: Uuid) -> Result<bool, sqlx::Error> {
        let artists = self.repo.list_artist_uuids_for_track(track_uuid).await?;
        let deleted = self.repo.delete_owned_track(owner, track_uuid).await?;
        if deleted {
            self.audio.remove(track_uuid).await;
            if !artists.is_empty() {
                self.repo.decrement_tracks_count(&artists).await?;
            }
        }
        Ok(deleted)
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
