//! Upload personal/platform tracks + create artist — паритет с C# MusicTrackService / MusicArtistService.

use std::collections::HashSet;
use std::sync::Arc;

use chrono::Utc;
use flora_music_contracts::{MusicArtistSummaryDto, UploadMusicTrackResultDto};
use flora_shared::flora_uuid::new_uuid;
use uuid::Uuid;

use crate::application::audio_search::AudioSearchHost;
use crate::application::credits::{
    CreditInput, compose_display, parse_artist_credits, resolve_role, validate_upload_credits,
};
use crate::application::upload_validation::{
    normalize_artist, normalize_content_type, normalize_title, validate_audio, validate_cover,
    validate_license_id,
};
use crate::domain::artist_name;
use crate::infrastructure::ffmpeg::{FfmpegMusicAudioTranscoder, PreparedAudio, TranscodeError};
use crate::infrastructure::repo::{MusicRepo, NewTrackArtistRow, NewTrackRow};

pub struct UploadService {
    repo: Arc<MusicRepo>,
    transcoder: Arc<FfmpegMusicAudioTranscoder>,
    audio: AudioSearchHost,
}

#[derive(Debug)]
pub enum UploadError {
    BadRequest(String),
    Unavailable,
    Db(sqlx::Error),
}

impl From<sqlx::Error> for UploadError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(value)
    }
}

impl UploadError {
    pub fn status_and_message(&self) -> (axum::http::StatusCode, &str) {
        match self {
            Self::BadRequest(m) => (axum::http::StatusCode::BAD_REQUEST, m.as_str()),
            Self::Unavailable => (
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                TranscodeError::Unavailable.message(),
            ),
            Self::Db(_) => (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Внутренняя ошибка сервера.",
            ),
        }
    }
}

impl UploadService {
    pub fn new(
        repo: Arc<MusicRepo>,
        transcoder: Arc<FfmpegMusicAudioTranscoder>,
        audio: AudioSearchHost,
    ) -> Self {
        Self {
            repo,
            transcoder,
            audio,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn upload_personal(
        &self,
        owner: Uuid,
        title: Option<&str>,
        artist: Option<&str>,
        artist_credits_json: Option<&str>,
        tags: Option<&str>,
        cover_color_id: Option<&str>,
        track_kind_id: Option<&str>,
        duration_ms: i32,
        file_name: &str,
        content_type: &str,
        audio_bytes: Vec<u8>,
    ) -> Result<UploadMusicTrackResultDto, UploadError> {
        if let Some(err) = validate_audio(
            Some(content_type),
            Some(file_name),
            audio_bytes.len() as i64,
        ) {
            return Err(UploadError::BadRequest(err.into()));
        }

        let prepared = self
            .prepare_audio(&audio_bytes, content_type, file_name)
            .await?;

        let track_uuid = new_uuid();
        let credit_inputs = parse_artist_credits(artist_credits_json);
        let (artist_display, prepared_credits) = if credit_inputs.is_empty() {
            let name = normalize_artist(artist);
            if name.is_empty() {
                return Err(UploadError::BadRequest("Укажите исполнителя.".into()));
            }
            (name, Vec::new())
        } else {
            self.prepare_credits(track_uuid, &credit_inputs).await?
        };

        let duration = if prepared.duration_ms > 0 {
            prepared.duration_ms
        } else {
            duration_ms.max(0)
        };

        let tags = tags
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let cover_color = cover_color_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("forest")
            .to_string();
        let track_kind = track_kind_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("song")
            .to_string();

        let title = normalize_title(title);
        let row = NewTrackRow {
            track_uuid,
            owner_user_uuid: owner,
            scope: 0,
            title: title.clone(),
            artist_display: artist_display.clone(),
            tags,
            genre_id: None,
            license_id: None,
            cover_color_id: Some(cover_color),
            track_kind_id: Some(track_kind),
            content_type: prepared.content_type,
            audio_data: prepared.data,
            cover_data: None,
            cover_content_type: None,
            duration_ms: duration,
            file_size_bytes: prepared.file_size_bytes,
            published_at: None,
            created_at: Utc::now(),
        };
        self.repo.insert_track(&row).await?;
        if !prepared_credits.is_empty() {
            self.attach_credits(&prepared_credits).await?;
        }
        Ok(UploadMusicTrackResultDto {
            track_uuid,
            title,
            artist_display,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn upload_platform(
        &self,
        owner: Uuid,
        title: Option<&str>,
        artist: Option<&str>,
        artist_credits_json: Option<&str>,
        genre_id: Option<&str>,
        license_id: Option<&str>,
        terms_accepted: bool,
        duration_ms: i32,
        file_name: &str,
        content_type: &str,
        audio_bytes: Vec<u8>,
        cover_content_type: Option<&str>,
        cover_bytes: Option<Vec<u8>>,
    ) -> Result<UploadMusicTrackResultDto, UploadError> {
        if !terms_accepted {
            return Err(UploadError::BadRequest(
                "Примите условия пользовательского соглашения.".into(),
            ));
        }
        if let Some(err) = validate_audio(
            Some(content_type),
            Some(file_name),
            audio_bytes.len() as i64,
        ) {
            return Err(UploadError::BadRequest(err.into()));
        }
        let genre = genre_id.map(str::trim).unwrap_or("");
        if genre.is_empty() {
            return Err(UploadError::BadRequest("Выберите жанр.".into()));
        }
        if let Some(err) = validate_license_id(license_id) {
            return Err(UploadError::BadRequest(err.into()));
        }

        let mut cover_data = None;
        let mut cover_ct = None;
        if let Some(bytes) = cover_bytes.filter(|b| !b.is_empty()) {
            if let Some(err) = validate_cover(cover_content_type, bytes.len() as i64) {
                return Err(UploadError::BadRequest(err.into()));
            }
            cover_ct = Some(normalize_content_type(cover_content_type));
            cover_data = Some(bytes);
        }

        let prepared = self
            .prepare_audio(&audio_bytes, content_type, file_name)
            .await?;

        let mut credits = parse_artist_credits(artist_credits_json);
        if credits.is_empty() {
            credits = self.resolve_obsolete_artist(owner, artist).await?;
        }

        let track_uuid = new_uuid();
        let (artist_display, prepared_credits) = self.prepare_credits(track_uuid, &credits).await?;

        let duration = if prepared.duration_ms > 0 {
            prepared.duration_ms
        } else {
            duration_ms.max(0)
        };

        let title = normalize_title(title);
        let row = NewTrackRow {
            track_uuid,
            owner_user_uuid: owner,
            scope: 1,
            title: title.clone(),
            artist_display: artist_display.clone(),
            tags: None,
            genre_id: Some(genre.to_string()),
            license_id: Some(license_id.unwrap_or("").trim().to_string()),
            cover_color_id: None,
            track_kind_id: None,
            content_type: prepared.content_type,
            audio_data: prepared.data,
            cover_data,
            cover_content_type: cover_ct,
            duration_ms: duration,
            file_size_bytes: prepared.file_size_bytes,
            published_at: Some(Utc::now()),
            created_at: Utc::now(),
        };
        self.repo.insert_track(&row).await?;
        self.attach_credits(&prepared_credits).await?;
        self.audio
            .upsert_if_catalog(
                row.track_uuid,
                row.scope,
                &row.title,
                &row.artist_display,
                prepared_credits.first().map(|c| c.artist_uuid),
                row.tags.as_deref(),
                row.genre_id.as_deref(),
                row.published_at,
            )
            .await;
        Ok(UploadMusicTrackResultDto {
            track_uuid,
            title,
            artist_display,
        })
    }

    pub async fn create_artist(
        &self,
        actor: Uuid,
        display_name: &str,
        link_to_my_profile: bool,
        cover_bytes: Option<Vec<u8>>,
        cover_content_type: Option<&str>,
    ) -> Result<MusicArtistSummaryDto, UploadError> {
        let name = display_name.trim();
        if name.is_empty() {
            return Err(UploadError::BadRequest("Укажите имя исполнителя.".into()));
        }
        if link_to_my_profile && self.repo.find_linked_by_user(actor).await?.is_some() {
            return Err(UploadError::BadRequest(
                "У вас уже есть исполнитель, привязанный к профилю.".into(),
            ));
        }

        let mut cover_data = None;
        let mut cover_ct = None;
        let mut has_cover = false;
        if let Some(bytes) = cover_bytes.filter(|b| !b.is_empty()) {
            if let Some(err) = validate_cover(cover_content_type, bytes.len() as i64) {
                return Err(UploadError::BadRequest(err.into()));
            }
            cover_ct = Some(normalize_content_type(cover_content_type));
            has_cover = true;
            cover_data = Some(bytes);
        }

        let id = new_uuid();
        let normalized = artist_name::normalize(name);
        let linked = if link_to_my_profile {
            Some(actor)
        } else {
            None
        };
        self.repo
            .insert_artist(
                id,
                name,
                &normalized,
                linked,
                actor,
                cover_data.as_deref(),
                cover_ct.as_deref(),
                Utc::now(),
            )
            .await?;

        Ok(MusicArtistSummaryDto {
            artist_uuid: id,
            display_name: name.to_string(),
            linked_user_uuid: linked,
            created_by_user_uuid: actor,
            tracks_count: 0,
            has_cover_image: has_cover,
        })
    }

    async fn prepare_audio(
        &self,
        bytes: &[u8],
        content_type: &str,
        file_name: &str,
    ) -> Result<PreparedAudio, UploadError> {
        match self
            .transcoder
            .prepare(bytes, content_type, file_name)
            .await
        {
            Ok(p) => Ok(p),
            Err(TranscodeError::Unavailable) => Err(UploadError::Unavailable),
            Err(TranscodeError::BadRequest(m)) => Err(UploadError::BadRequest(m)),
        }
    }

    async fn resolve_obsolete_artist(
        &self,
        owner: Uuid,
        artist: Option<&str>,
    ) -> Result<Vec<CreditInput>, UploadError> {
        let name = normalize_artist(artist);
        if name.is_empty() {
            return Err(UploadError::BadRequest(
                "Укажите хотя бы одного исполнителя.".into(),
            ));
        }
        let normalized = artist_name::normalize(&name);
        if let Some((id, _)) = self
            .repo
            .find_by_normalized_name_and_creator(&normalized, owner)
            .await?
        {
            return Ok(vec![CreditInput {
                artist_uuid: id,
                joiner_before: 0,
            }]);
        }
        let id = new_uuid();
        self.repo
            .insert_artist(id, &name, &normalized, None, owner, None, None, Utc::now())
            .await?;
        Ok(vec![CreditInput {
            artist_uuid: id,
            joiner_before: 0,
        }])
    }

    async fn prepare_credits(
        &self,
        track_uuid: Uuid,
        inputs: &[CreditInput],
    ) -> Result<(String, Vec<NewTrackArtistRow>), UploadError> {
        if let Some(err) = validate_upload_credits(inputs) {
            return Err(UploadError::BadRequest(err.into()));
        }
        let ids: Vec<Uuid> = inputs.iter().map(|c| c.artist_uuid).collect();
        let distinct: HashSet<Uuid> = ids.iter().copied().collect();
        let artists = self.repo.find_artists_by_uuids(&ids).await?;
        if artists.len() != distinct.len() {
            return Err(UploadError::BadRequest(
                "Один или несколько исполнителей не найдены.".into(),
            ));
        }
        let map: std::collections::HashMap<Uuid, String> = artists.into_iter().collect();
        let mut composed = Vec::new();
        let mut rows = Vec::new();
        for (i, input) in inputs.iter().enumerate() {
            let name = map.get(&input.artist_uuid).cloned().ok_or_else(|| {
                UploadError::BadRequest("Один или несколько исполнителей не найдены.".into())
            })?;
            composed.push((name, input.joiner_before));
            rows.push(NewTrackArtistRow {
                music_track_artist_uuid: new_uuid(),
                track_uuid,
                artist_uuid: input.artist_uuid,
                role: resolve_role(input.joiner_before, i),
                joiner_before: input.joiner_before,
                sort_order: i as i32,
            });
        }
        Ok((compose_display(&composed), rows))
    }

    async fn attach_credits(&self, rows: &[NewTrackArtistRow]) -> Result<(), UploadError> {
        if rows.is_empty() {
            return Ok(());
        }
        self.repo.insert_track_artists(rows).await?;
        let mut distinct = HashSet::new();
        for r in rows {
            distinct.insert(r.artist_uuid);
        }
        let ids: Vec<Uuid> = distinct.into_iter().collect();
        self.repo.increment_tracks_count(&ids).await?;
        Ok(())
    }
}
