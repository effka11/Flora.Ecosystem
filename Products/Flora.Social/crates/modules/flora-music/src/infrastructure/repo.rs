//! sqlx-репозиторий Music. Схема `flora_core`, таблицы модуля без изменений.

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct TrackListRow {
    pub track_uuid: Uuid,
    pub owner_user_uuid: Uuid,
    pub scope: i32,
    pub title: String,
    pub artist_display: String,
    pub tags: Option<String>,
    pub genre_id: Option<String>,
    pub license_id: Option<String>,
    pub cover_color_id: Option<String>,
    pub track_kind_id: Option<String>,
    pub has_cover_image: bool,
    pub duration_ms: i32,
    pub created_at: DateTime<Utc>,
    pub published_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct CreditRow {
    pub track_uuid: Uuid,
    pub artist_uuid: Uuid,
    pub display_name: String,
    pub joiner_before: i32,
    pub sort_order: i32,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PlaylistListRow {
    pub playlist_uuid: Uuid,
    pub title: String,
    pub cover_color_id: Option<String>,
    pub track_count: i64,
}

pub struct MusicRepo {
    pool: PgPool,
}

impl MusicRepo {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn list_library(&self, owner: Uuid) -> Result<Vec<TrackListRow>, sqlx::Error> {
        sqlx::query_as::<_, TrackListRow>(
            r#"
            SELECT track_uuid, owner_user_uuid, scope, title, artist_display, tags,
                   genre_id, license_id, cover_color_id, track_kind_id,
                   (cover_data IS NOT NULL AND length(cover_data) > 0) AS has_cover_image,
                   duration_ms, created_at, published_at
            FROM flora_core.music_tracks
            WHERE owner_user_uuid = $1
            ORDER BY created_at DESC
            "#,
        )
        .bind(owner)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn list_platform_catalog(&self) -> Result<Vec<TrackListRow>, sqlx::Error> {
        sqlx::query_as::<_, TrackListRow>(
            r#"
            SELECT track_uuid, owner_user_uuid, scope, title, artist_display, tags,
                   genre_id, license_id, cover_color_id, track_kind_id,
                   (cover_data IS NOT NULL AND length(cover_data) > 0) AS has_cover_image,
                   duration_ms, created_at, published_at
            FROM flora_core.music_tracks
            WHERE scope = 1 AND published_at IS NOT NULL
            ORDER BY published_at DESC
            "#,
        )
        .fetch_all(&self.pool)
        .await
    }

    pub async fn list_catalog_tracks_by_uuids(
        &self,
        track_ids: &[Uuid],
    ) -> Result<Vec<TrackListRow>, sqlx::Error> {
        if track_ids.is_empty() {
            return Ok(Vec::new());
        }
        sqlx::query_as::<_, TrackListRow>(
            r#"
            SELECT track_uuid, owner_user_uuid, scope, title, artist_display, tags,
                   genre_id, license_id, cover_color_id, track_kind_id,
                   (cover_data IS NOT NULL AND length(cover_data) > 0) AS has_cover_image,
                   duration_ms, created_at, published_at
            FROM flora_core.music_tracks
            WHERE track_uuid = ANY($1) AND scope = 1 AND published_at IS NOT NULL
            "#,
        )
        .bind(track_ids)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn list_credits_for_tracks(
        &self,
        track_ids: &[Uuid],
    ) -> Result<Vec<CreditRow>, sqlx::Error> {
        if track_ids.is_empty() {
            return Ok(Vec::new());
        }
        sqlx::query_as::<_, CreditRow>(
            r#"
            SELECT mta.track_uuid, mta.artist_uuid, a.display_name, mta.joiner_before, mta.sort_order
            FROM flora_core.music_track_artists mta
            INNER JOIN flora_core.music_artists a ON a.artist_uuid = mta.artist_uuid
            WHERE mta.track_uuid = ANY($1)
            ORDER BY mta.track_uuid, mta.sort_order
            "#,
        )
        .bind(track_ids)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn count_personal(&self, owner: Uuid) -> Result<i64, sqlx::Error> {
        let (n,): (i64,) = sqlx::query_as(
            r#"
            SELECT COUNT(*)::bigint FROM flora_core.music_tracks
            WHERE owner_user_uuid = $1 AND scope = 0
            "#,
        )
        .bind(owner)
        .fetch_one(&self.pool)
        .await?;
        Ok(n)
    }

    pub async fn count_platform_owned(&self, owner: Uuid) -> Result<i64, sqlx::Error> {
        let (n,): (i64,) = sqlx::query_as(
            r#"
            SELECT COUNT(*)::bigint FROM flora_core.music_tracks
            WHERE owner_user_uuid = $1 AND scope = 1
            "#,
        )
        .bind(owner)
        .fetch_one(&self.pool)
        .await?;
        Ok(n)
    }

    pub async fn list_personal_tracks(
        &self,
        owner: Uuid,
    ) -> Result<Vec<TrackListRow>, sqlx::Error> {
        sqlx::query_as::<_, TrackListRow>(
            r#"
            SELECT track_uuid, owner_user_uuid, scope, title, artist_display, tags,
                   genre_id, license_id, cover_color_id, track_kind_id,
                   (cover_data IS NOT NULL AND length(cover_data) > 0) AS has_cover_image,
                   duration_ms, created_at, published_at
            FROM flora_core.music_tracks
            WHERE owner_user_uuid = $1 AND scope = 0
            ORDER BY created_at DESC
            "#,
        )
        .bind(owner)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn list_platform_owned_tracks(
        &self,
        owner: Uuid,
    ) -> Result<Vec<TrackListRow>, sqlx::Error> {
        sqlx::query_as::<_, TrackListRow>(
            r#"
            SELECT track_uuid, owner_user_uuid, scope, title, artist_display, tags,
                   genre_id, license_id, cover_color_id, track_kind_id,
                   (cover_data IS NOT NULL AND length(cover_data) > 0) AS has_cover_image,
                   duration_ms, created_at, published_at
            FROM flora_core.music_tracks
            WHERE owner_user_uuid = $1 AND scope = 1
            ORDER BY created_at DESC
            "#,
        )
        .bind(owner)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn list_user_playlists(
        &self,
        owner: Uuid,
    ) -> Result<Vec<PlaylistListRow>, sqlx::Error> {
        sqlx::query_as::<_, PlaylistListRow>(
            r#"
            SELECT p.playlist_uuid, p.title, p.cover_color_id,
                   COUNT(pt.track_uuid)::bigint AS track_count
            FROM flora_core.music_playlists p
            LEFT JOIN flora_core.music_playlist_tracks pt ON pt.playlist_uuid = p.playlist_uuid
            WHERE p.owner_user_uuid = $1
            GROUP BY p.playlist_uuid, p.title, p.cover_color_id, p.created_at
            ORDER BY p.created_at DESC
            "#,
        )
        .bind(owner)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn find_user_playlist(
        &self,
        owner: Uuid,
        playlist_uuid: Uuid,
    ) -> Result<Option<PlaylistListRow>, sqlx::Error> {
        sqlx::query_as::<_, PlaylistListRow>(
            r#"
            SELECT p.playlist_uuid, p.title, p.cover_color_id,
                   COUNT(pt.track_uuid)::bigint AS track_count
            FROM flora_core.music_playlists p
            LEFT JOIN flora_core.music_playlist_tracks pt ON pt.playlist_uuid = p.playlist_uuid
            WHERE p.owner_user_uuid = $1 AND p.playlist_uuid = $2
            GROUP BY p.playlist_uuid, p.title, p.cover_color_id
            "#,
        )
        .bind(owner)
        .bind(playlist_uuid)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn list_playlist_tracks(
        &self,
        playlist_uuid: Uuid,
    ) -> Result<Vec<TrackListRow>, sqlx::Error> {
        sqlx::query_as::<_, TrackListRow>(
            r#"
            SELECT t.track_uuid, t.owner_user_uuid, t.scope, t.title, t.artist_display, t.tags,
                   t.genre_id, t.license_id, t.cover_color_id, t.track_kind_id,
                   (t.cover_data IS NOT NULL AND length(t.cover_data) > 0) AS has_cover_image,
                   t.duration_ms, t.created_at, t.published_at
            FROM flora_core.music_playlist_tracks pt
            INNER JOIN flora_core.music_tracks t ON t.track_uuid = pt.track_uuid
            WHERE pt.playlist_uuid = $1
            ORDER BY pt.position ASC, pt.added_at DESC
            "#,
        )
        .bind(playlist_uuid)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn count_platform_by_scope(
        &self,
        genre_id: Option<&str>,
        subgenre_id: Option<&str>,
    ) -> Result<i64, sqlx::Error> {
        let (n,): (i64,) = match (subgenre_id, genre_id) {
            (Some(sub), _) => {
                sqlx::query_as(
                    r#"
                    SELECT COUNT(*)::bigint FROM flora_core.music_tracks
                    WHERE scope = 1 AND published_at IS NOT NULL AND genre_id = $1
                    "#,
                )
                .bind(sub)
                .fetch_one(&self.pool)
                .await?
            }
            (None, Some(genre)) => {
                let prefix = format!("{genre}-%");
                sqlx::query_as(
                    r#"
                    SELECT COUNT(*)::bigint FROM flora_core.music_tracks
                    WHERE scope = 1 AND published_at IS NOT NULL
                      AND (genre_id = $1 OR genre_id LIKE $2)
                    "#,
                )
                .bind(genre)
                .bind(prefix)
                .fetch_one(&self.pool)
                .await?
            }
            (None, None) => {
                sqlx::query_as(
                    r#"
                    SELECT COUNT(*)::bigint FROM flora_core.music_tracks
                    WHERE scope = 1 AND published_at IS NOT NULL
                    "#,
                )
                .fetch_one(&self.pool)
                .await?
            }
        };
        Ok(n)
    }

    pub async fn list_new_platform_by_scope(
        &self,
        genre_id: Option<&str>,
        subgenre_id: Option<&str>,
        take: i64,
    ) -> Result<Vec<TrackListRow>, sqlx::Error> {
        self.list_platform_scoped(genre_id, subgenre_id, take, OrderBy::PublishedAt)
            .await
    }

    pub async fn list_popular_platform_by_scope(
        &self,
        genre_id: Option<&str>,
        subgenre_id: Option<&str>,
        take: i64,
    ) -> Result<Vec<TrackListRow>, sqlx::Error> {
        self.list_platform_scoped(genre_id, subgenre_id, take, OrderBy::CreatedThenPublished)
            .await
    }

    async fn list_platform_scoped(
        &self,
        genre_id: Option<&str>,
        subgenre_id: Option<&str>,
        take: i64,
        order: OrderBy,
    ) -> Result<Vec<TrackListRow>, sqlx::Error> {
        let limit = take.clamp(1, 50);
        match (subgenre_id, genre_id, order) {
            (Some(sub), _, OrderBy::PublishedAt) => {
                sqlx::query_as::<_, TrackListRow>(
                    r#"
                    SELECT track_uuid, owner_user_uuid, scope, title, artist_display, tags,
                           genre_id, license_id, cover_color_id, track_kind_id,
                           (cover_data IS NOT NULL AND length(cover_data) > 0) AS has_cover_image,
                           duration_ms, created_at, published_at
                    FROM flora_core.music_tracks
                    WHERE scope = 1 AND published_at IS NOT NULL AND genre_id = $1
                    ORDER BY published_at DESC
                    LIMIT $2
                    "#,
                )
                .bind(sub)
                .bind(limit)
                .fetch_all(&self.pool)
                .await
            }
            (Some(sub), _, OrderBy::CreatedThenPublished) => {
                sqlx::query_as::<_, TrackListRow>(
                    r#"
                    SELECT track_uuid, owner_user_uuid, scope, title, artist_display, tags,
                           genre_id, license_id, cover_color_id, track_kind_id,
                           (cover_data IS NOT NULL AND length(cover_data) > 0) AS has_cover_image,
                           duration_ms, created_at, published_at
                    FROM flora_core.music_tracks
                    WHERE scope = 1 AND published_at IS NOT NULL AND genre_id = $1
                    ORDER BY created_at DESC, published_at DESC
                    LIMIT $2
                    "#,
                )
                .bind(sub)
                .bind(limit)
                .fetch_all(&self.pool)
                .await
            }
            (None, Some(genre), OrderBy::PublishedAt) => {
                let prefix = format!("{genre}-%");
                sqlx::query_as::<_, TrackListRow>(
                    r#"
                    SELECT track_uuid, owner_user_uuid, scope, title, artist_display, tags,
                           genre_id, license_id, cover_color_id, track_kind_id,
                           (cover_data IS NOT NULL AND length(cover_data) > 0) AS has_cover_image,
                           duration_ms, created_at, published_at
                    FROM flora_core.music_tracks
                    WHERE scope = 1 AND published_at IS NOT NULL
                      AND (genre_id = $1 OR genre_id LIKE $2)
                    ORDER BY published_at DESC
                    LIMIT $3
                    "#,
                )
                .bind(genre)
                .bind(prefix)
                .bind(limit)
                .fetch_all(&self.pool)
                .await
            }
            (None, Some(genre), OrderBy::CreatedThenPublished) => {
                let prefix = format!("{genre}-%");
                sqlx::query_as::<_, TrackListRow>(
                    r#"
                    SELECT track_uuid, owner_user_uuid, scope, title, artist_display, tags,
                           genre_id, license_id, cover_color_id, track_kind_id,
                           (cover_data IS NOT NULL AND length(cover_data) > 0) AS has_cover_image,
                           duration_ms, created_at, published_at
                    FROM flora_core.music_tracks
                    WHERE scope = 1 AND published_at IS NOT NULL
                      AND (genre_id = $1 OR genre_id LIKE $2)
                    ORDER BY created_at DESC, published_at DESC
                    LIMIT $3
                    "#,
                )
                .bind(genre)
                .bind(prefix)
                .bind(limit)
                .fetch_all(&self.pool)
                .await
            }
            (None, None, OrderBy::PublishedAt) => {
                sqlx::query_as::<_, TrackListRow>(
                    r#"
                    SELECT track_uuid, owner_user_uuid, scope, title, artist_display, tags,
                           genre_id, license_id, cover_color_id, track_kind_id,
                           (cover_data IS NOT NULL AND length(cover_data) > 0) AS has_cover_image,
                           duration_ms, created_at, published_at
                    FROM flora_core.music_tracks
                    WHERE scope = 1 AND published_at IS NOT NULL
                    ORDER BY published_at DESC
                    LIMIT $1
                    "#,
                )
                .bind(limit)
                .fetch_all(&self.pool)
                .await
            }
            (None, None, OrderBy::CreatedThenPublished) => {
                sqlx::query_as::<_, TrackListRow>(
                    r#"
                    SELECT track_uuid, owner_user_uuid, scope, title, artist_display, tags,
                           genre_id, license_id, cover_color_id, track_kind_id,
                           (cover_data IS NOT NULL AND length(cover_data) > 0) AS has_cover_image,
                           duration_ms, created_at, published_at
                    FROM flora_core.music_tracks
                    WHERE scope = 1 AND published_at IS NOT NULL
                    ORDER BY created_at DESC, published_at DESC
                    LIMIT $1
                    "#,
                )
                .bind(limit)
                .fetch_all(&self.pool)
                .await
            }
        }
    }

    pub async fn list_featured_artists(
        &self,
        take: i32,
    ) -> Result<Vec<ArtistListRow>, sqlx::Error> {
        let clamped = take.clamp(1, 50);
        sqlx::query_as::<_, ArtistListRow>(
            r#"
            SELECT artist_uuid, display_name, linked_user_uuid, created_by_user_uuid, tracks_count,
                   (cover_data IS NOT NULL AND length(cover_data) > 0) AS has_cover_image
            FROM flora_core.music_artists
            ORDER BY tracks_count DESC, display_name ASC
            LIMIT $1
            "#,
        )
        .bind(clamped)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn search_artists(
        &self,
        normalized_query: &str,
        query_len: usize,
        limit: i32,
    ) -> Result<Vec<ArtistListRow>, sqlx::Error> {
        let clamped = limit.clamp(1, 20);
        let pattern = if query_len == 1 {
            format!("{normalized_query}%")
        } else {
            format!("%{normalized_query}%")
        };
        sqlx::query_as::<_, ArtistListRow>(
            r#"
            SELECT artist_uuid, display_name, linked_user_uuid, created_by_user_uuid, tracks_count,
                   (cover_data IS NOT NULL AND length(cover_data) > 0) AS has_cover_image
            FROM flora_core.music_artists
            WHERE normalized_display_name ILIKE $1
            ORDER BY tracks_count DESC, display_name ASC
            LIMIT $2
            "#,
        )
        .bind(pattern)
        .bind(clamped)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn find_artist(
        &self,
        artist_uuid: Uuid,
    ) -> Result<Option<ArtistListRow>, sqlx::Error> {
        sqlx::query_as::<_, ArtistListRow>(
            r#"
            SELECT artist_uuid, display_name, linked_user_uuid, created_by_user_uuid, tracks_count,
                   (cover_data IS NOT NULL AND length(cover_data) > 0) AS has_cover_image
            FROM flora_core.music_artists
            WHERE artist_uuid = $1
            "#,
        )
        .bind(artist_uuid)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn find_artist_cover(
        &self,
        artist_uuid: Uuid,
    ) -> Result<Option<MediaBlobRow>, sqlx::Error> {
        sqlx::query_as::<_, MediaBlobRow>(
            r#"
            SELECT cover_data AS data,
                   COALESCE(cover_content_type, 'image/jpeg') AS content_type
            FROM flora_core.music_artists
            WHERE artist_uuid = $1
              AND cover_data IS NOT NULL
              AND length(cover_data) > 0
            "#,
        )
        .bind(artist_uuid)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn count_artist_tracks_visible(
        &self,
        artist_uuid: Uuid,
        requester: Uuid,
    ) -> Result<i64, sqlx::Error> {
        let (n,): (i64,) = sqlx::query_as(
            r#"
            SELECT COUNT(*)::bigint
            FROM flora_core.music_tracks t
            WHERE EXISTS (
                SELECT 1 FROM flora_core.music_track_artists mta
                WHERE mta.artist_uuid = $1 AND mta.track_uuid = t.track_uuid
            )
              AND (t.owner_user_uuid = $2 OR (t.scope = 1 AND t.published_at IS NOT NULL))
            "#,
        )
        .bind(artist_uuid)
        .bind(requester)
        .fetch_one(&self.pool)
        .await?;
        Ok(n)
    }

    pub async fn list_artist_tracks_paged(
        &self,
        artist_uuid: Uuid,
        requester: Uuid,
        page: i32,
        page_size: i32,
    ) -> Result<Vec<TrackListRow>, sqlx::Error> {
        let safe_page = page.max(1);
        let safe_size = page_size.clamp(1, 100);
        let offset = (safe_page - 1) * safe_size;
        sqlx::query_as::<_, TrackListRow>(
            r#"
            SELECT t.track_uuid, t.owner_user_uuid, t.scope, t.title, t.artist_display, t.tags,
                   t.genre_id, t.license_id, t.cover_color_id, t.track_kind_id,
                   (t.cover_data IS NOT NULL AND length(t.cover_data) > 0) AS has_cover_image,
                   t.duration_ms, t.created_at, t.published_at
            FROM flora_core.music_tracks t
            WHERE EXISTS (
                SELECT 1 FROM flora_core.music_track_artists mta
                WHERE mta.artist_uuid = $1 AND mta.track_uuid = t.track_uuid
            )
              AND (t.owner_user_uuid = $2 OR (t.scope = 1 AND t.published_at IS NOT NULL))
            ORDER BY COALESCE(t.published_at, t.created_at) DESC, t.created_at DESC
            LIMIT $3 OFFSET $4
            "#,
        )
        .bind(artist_uuid)
        .bind(requester)
        .bind(safe_size)
        .bind(offset)
        .fetch_all(&self.pool)
        .await
    }

    /// Owner OR published platform — как FindAudioAccessibleAsync / FindCoverAccessibleAsync.
    pub async fn find_track_audio_accessible(
        &self,
        requester: Uuid,
        track_uuid: Uuid,
    ) -> Result<Option<MediaBlobRow>, sqlx::Error> {
        sqlx::query_as::<_, MediaBlobRow>(
            r#"
            SELECT audio_data AS data, content_type
            FROM flora_core.music_tracks
            WHERE track_uuid = $1
              AND (owner_user_uuid = $2 OR (scope = 1 AND published_at IS NOT NULL))
              AND length(audio_data) > 0
            "#,
        )
        .bind(track_uuid)
        .bind(requester)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn find_track_cover_accessible(
        &self,
        requester: Uuid,
        track_uuid: Uuid,
    ) -> Result<Option<MediaBlobRow>, sqlx::Error> {
        sqlx::query_as::<_, MediaBlobRow>(
            r#"
            SELECT cover_data AS data,
                   COALESCE(NULLIF(TRIM(cover_content_type), ''), 'application/octet-stream') AS content_type
            FROM flora_core.music_tracks
            WHERE track_uuid = $1
              AND (owner_user_uuid = $2 OR (scope = 1 AND published_at IS NOT NULL))
              AND cover_data IS NOT NULL
              AND length(cover_data) > 0
            "#,
        )
        .bind(track_uuid)
        .bind(requester)
        .fetch_optional(&self.pool)
        .await
    }

    /// FIRA-M candidate pool (limit up to MaxCandidates, not genre-page 50).
    pub async fn list_published_platform_candidates(
        &self,
        limit: i32,
    ) -> Result<Vec<TrackListRow>, sqlx::Error> {
        let limit = limit.clamp(1, 2000);
        sqlx::query_as::<_, TrackListRow>(
            r#"
            SELECT track_uuid, owner_user_uuid, scope, title, artist_display, tags,
                   genre_id, license_id, cover_color_id, track_kind_id,
                   (cover_data IS NOT NULL AND length(cover_data) > 0) AS has_cover_image,
                   duration_ms, created_at, published_at
            FROM flora_core.music_tracks
            WHERE scope = 1 AND published_at IS NOT NULL
            ORDER BY published_at DESC
            LIMIT $1
            "#,
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn list_published_platform_candidates_by_scope(
        &self,
        genre_id: Option<&str>,
        subgenre_id: Option<&str>,
        limit: i32,
    ) -> Result<Vec<TrackListRow>, sqlx::Error> {
        let limit = limit.clamp(1, 2000);
        if let Some(sub) = subgenre_id.map(str::trim).filter(|s| !s.is_empty()) {
            return sqlx::query_as::<_, TrackListRow>(
                r#"
                SELECT track_uuid, owner_user_uuid, scope, title, artist_display, tags,
                       genre_id, license_id, cover_color_id, track_kind_id,
                       (cover_data IS NOT NULL AND length(cover_data) > 0) AS has_cover_image,
                       duration_ms, created_at, published_at
                FROM flora_core.music_tracks
                WHERE scope = 1 AND published_at IS NOT NULL AND genre_id = $1
                ORDER BY published_at DESC
                LIMIT $2
                "#,
            )
            .bind(sub)
            .bind(limit)
            .fetch_all(&self.pool)
            .await;
        }
        if let Some(genre) = genre_id.map(str::trim).filter(|s| !s.is_empty()) {
            let prefix = format!("{genre}-%");
            return sqlx::query_as::<_, TrackListRow>(
                r#"
                SELECT track_uuid, owner_user_uuid, scope, title, artist_display, tags,
                       genre_id, license_id, cover_color_id, track_kind_id,
                       (cover_data IS NOT NULL AND length(cover_data) > 0) AS has_cover_image,
                       duration_ms, created_at, published_at
                FROM flora_core.music_tracks
                WHERE scope = 1 AND published_at IS NOT NULL
                  AND (genre_id = $1 OR genre_id LIKE $2)
                ORDER BY published_at DESC
                LIMIT $3
                "#,
            )
            .bind(genre)
            .bind(prefix)
            .bind(limit)
            .fetch_all(&self.pool)
            .await;
        }
        self.list_published_platform_candidates(limit).await
    }

    /// 2× owned by genre + 1× favorites by genre.
    pub async fn get_user_genre_weights(
        &self,
        user: Uuid,
    ) -> Result<Vec<(String, i32)>, sqlx::Error> {
        let owned: Vec<(String, i32)> = sqlx::query_as(
            r#"
            SELECT genre_id, (COUNT(*)::int * 2) AS weight
            FROM flora_core.music_tracks
            WHERE owner_user_uuid = $1
              AND genre_id IS NOT NULL AND genre_id <> ''
            GROUP BY genre_id
            "#,
        )
        .bind(user)
        .fetch_all(&self.pool)
        .await?;

        let favs: Vec<(String, i32)> = sqlx::query_as(
            r#"
            SELECT t.genre_id, COUNT(*)::int AS weight
            FROM flora_core.music_favorites f
            INNER JOIN flora_core.music_tracks t ON t.track_uuid = f.track_uuid
            WHERE f.user_uuid = $1
              AND t.genre_id IS NOT NULL AND t.genre_id <> ''
            GROUP BY t.genre_id
            "#,
        )
        .bind(user)
        .fetch_all(&self.pool)
        .await?;

        let mut map = std::collections::HashMap::<String, i32>::new();
        for (g, w) in owned.into_iter().chain(favs) {
            let key = flora_shared::ordinal::upper_invariant_key(&g);
            *map.entry(key).or_default() += w;
        }
        Ok(map.into_iter().collect())
    }

    pub async fn is_track_owned(&self, owner: Uuid, track: Uuid) -> Result<bool, sqlx::Error> {
        let row: Option<(i32,)> = sqlx::query_as(
            r#"
            SELECT 1 FROM flora_core.music_tracks
            WHERE owner_user_uuid = $1 AND track_uuid = $2
            "#,
        )
        .bind(owner)
        .bind(track)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.is_some())
    }

    pub async fn track_exists(&self, track: Uuid) -> Result<bool, sqlx::Error> {
        let row: Option<(i32,)> = sqlx::query_as(
            r#"
            SELECT 1 FROM flora_core.music_tracks
            WHERE track_uuid = $1
            "#,
        )
        .bind(track)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.is_some())
    }

    // §User Controls (FIRA-M v1.1): «не интересно» для треков Потока.

    pub async fn dismissed_track_ids(&self, user: Uuid) -> Result<Vec<Uuid>, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT track_uuid
            FROM flora_core.music_track_dismissals
            WHERE user_uuid = $1
            "#,
        )
        .bind(user)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn insert_track_dismissal(
        &self,
        user: Uuid,
        track: Uuid,
        created_at: DateTime<Utc>,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            r#"
            INSERT INTO flora_core.music_track_dismissals (user_uuid, track_uuid, created_at)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_uuid, track_uuid) DO NOTHING
            "#,
        )
        .bind(user)
        .bind(track)
        .bind(created_at)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn delete_track_dismissal(
        &self,
        user: Uuid,
        track: Uuid,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            r#"
            DELETE FROM flora_core.music_track_dismissals
            WHERE user_uuid = $1 AND track_uuid = $2
            "#,
        )
        .bind(user)
        .bind(track)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn is_favorite(&self, user: Uuid, track: Uuid) -> Result<bool, sqlx::Error> {
        let row: Option<(i32,)> = sqlx::query_as(
            r#"
            SELECT 1 FROM flora_core.music_favorites
            WHERE user_uuid = $1 AND track_uuid = $2
            "#,
        )
        .bind(user)
        .bind(track)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.is_some())
    }

    pub async fn insert_favorite(
        &self,
        user: Uuid,
        track: Uuid,
        created_at: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.music_favorites (user_uuid, track_uuid, created_at)
            VALUES ($1, $2, $3)
            "#,
        )
        .bind(user)
        .bind(track)
        .bind(created_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_favorite(&self, user: Uuid, track: Uuid) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            r#"
            DELETE FROM flora_core.music_favorites
            WHERE user_uuid = $1 AND track_uuid = $2
            "#,
        )
        .bind(user)
        .bind(track)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn insert_playlist(
        &self,
        playlist_uuid: Uuid,
        owner: Uuid,
        title: &str,
        created_at: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.music_playlists
                (playlist_uuid, owner_user_uuid, title, cover_color_id, created_at)
            VALUES ($1, $2, $3, 'forest', $4)
            "#,
        )
        .bind(playlist_uuid)
        .bind(owner)
        .bind(title)
        .bind(created_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_user_playlist(
        &self,
        owner: Uuid,
        playlist_uuid: Uuid,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            r#"
            DELETE FROM flora_core.music_playlists
            WHERE owner_user_uuid = $1 AND playlist_uuid = $2
            "#,
        )
        .bind(owner)
        .bind(playlist_uuid)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn list_artist_uuids_for_track(&self, track: Uuid) -> Result<Vec<Uuid>, sqlx::Error> {
        let rows: Vec<(Uuid,)> = sqlx::query_as(
            r#"
            SELECT DISTINCT artist_uuid
            FROM flora_core.music_track_artists
            WHERE track_uuid = $1
            "#,
        )
        .bind(track)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|(id,)| id).collect())
    }

    pub async fn delete_owned_track(&self, owner: Uuid, track: Uuid) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            r#"
            DELETE FROM flora_core.music_tracks
            WHERE owner_user_uuid = $1 AND track_uuid = $2
            "#,
        )
        .bind(owner)
        .bind(track)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn decrement_tracks_count(&self, artist_uuids: &[Uuid]) -> Result<(), sqlx::Error> {
        if artist_uuids.is_empty() {
            return Ok(());
        }
        sqlx::query(
            r#"
            UPDATE flora_core.music_artists
            SET tracks_count = tracks_count - 1
            WHERE artist_uuid = ANY($1) AND tracks_count > 0
            "#,
        )
        .bind(artist_uuids)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn increment_tracks_count(&self, artist_uuids: &[Uuid]) -> Result<(), sqlx::Error> {
        if artist_uuids.is_empty() {
            return Ok(());
        }
        sqlx::query(
            r#"
            UPDATE flora_core.music_artists
            SET tracks_count = tracks_count + 1
            WHERE artist_uuid = ANY($1)
            "#,
        )
        .bind(artist_uuids)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn find_artists_by_uuids(
        &self,
        ids: &[Uuid],
    ) -> Result<Vec<(Uuid, String)>, sqlx::Error> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        sqlx::query_as::<_, (Uuid, String)>(
            r#"
            SELECT artist_uuid, display_name
            FROM flora_core.music_artists
            WHERE artist_uuid = ANY($1)
            "#,
        )
        .bind(ids)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn find_by_normalized_name_and_creator(
        &self,
        normalized: &str,
        created_by: Uuid,
    ) -> Result<Option<(Uuid, String)>, sqlx::Error> {
        sqlx::query_as::<_, (Uuid, String)>(
            r#"
            SELECT artist_uuid, display_name
            FROM flora_core.music_artists
            WHERE normalized_display_name = $1 AND created_by_user_uuid = $2
            LIMIT 1
            "#,
        )
        .bind(normalized)
        .bind(created_by)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn find_linked_by_user(&self, user: Uuid) -> Result<Option<Uuid>, sqlx::Error> {
        let row: Option<(Uuid,)> = sqlx::query_as(
            r#"
            SELECT artist_uuid FROM flora_core.music_artists
            WHERE linked_user_uuid = $1
            LIMIT 1
            "#,
        )
        .bind(user)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|(id,)| id))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn insert_artist(
        &self,
        artist_uuid: Uuid,
        display_name: &str,
        normalized_display_name: &str,
        linked_user_uuid: Option<Uuid>,
        created_by_user_uuid: Uuid,
        cover_data: Option<&[u8]>,
        cover_content_type: Option<&str>,
        created_at: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.music_artists (
                artist_uuid, display_name, normalized_display_name, tracks_count,
                linked_user_uuid, created_by_user_uuid, cover_data, cover_content_type, created_at
            ) VALUES ($1,$2,$3,0,$4,$5,$6,$7,$8)
            "#,
        )
        .bind(artist_uuid)
        .bind(display_name)
        .bind(normalized_display_name)
        .bind(linked_user_uuid)
        .bind(created_by_user_uuid)
        .bind(cover_data)
        .bind(cover_content_type)
        .bind(created_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn insert_track(&self, t: &NewTrackRow) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.music_tracks (
                track_uuid, owner_user_uuid, scope, title, artist_display, tags,
                genre_id, license_id, cover_color_id, track_kind_id,
                content_type, audio_data, cover_data, cover_content_type,
                duration_ms, file_size_bytes, published_at, created_at
            ) VALUES (
                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
            )
            "#,
        )
        .bind(t.track_uuid)
        .bind(t.owner_user_uuid)
        .bind(t.scope)
        .bind(&t.title)
        .bind(&t.artist_display)
        .bind(&t.tags)
        .bind(&t.genre_id)
        .bind(&t.license_id)
        .bind(&t.cover_color_id)
        .bind(&t.track_kind_id)
        .bind(&t.content_type)
        .bind(&t.audio_data)
        .bind(&t.cover_data)
        .bind(&t.cover_content_type)
        .bind(t.duration_ms)
        .bind(t.file_size_bytes)
        .bind(t.published_at)
        .bind(t.created_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn insert_track_artists(
        &self,
        rows: &[NewTrackArtistRow],
    ) -> Result<(), sqlx::Error> {
        for r in rows {
            sqlx::query(
                r#"
                INSERT INTO flora_core.music_track_artists (
                    music_track_artist_uuid, track_uuid, artist_uuid, role, joiner_before, sort_order
                ) VALUES ($1,$2,$3,$4,$5,$6)
                "#,
            )
            .bind(r.music_track_artist_uuid)
            .bind(r.track_uuid)
            .bind(r.artist_uuid)
            .bind(r.role)
            .bind(r.joiner_before)
            .bind(r.sort_order)
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    pub async fn list_tracks_for_backfill(&self) -> Result<Vec<(Uuid, Uuid, String)>, sqlx::Error> {
        sqlx::query_as::<_, (Uuid, Uuid, String)>(
            r#"
            SELECT track_uuid, owner_user_uuid, artist_display
            FROM flora_core.music_tracks
            WHERE artist_display <> ''
            "#,
        )
        .fetch_all(&self.pool)
        .await
    }

    pub async fn track_has_artists(&self, track: Uuid) -> Result<bool, sqlx::Error> {
        let row: Option<(i32,)> = sqlx::query_as(
            r#"
            SELECT 1 FROM flora_core.music_track_artists
            WHERE track_uuid = $1
            LIMIT 1
            "#,
        )
        .bind(track)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.is_some())
    }

    pub async fn rebuild_tracks_count(&self) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE flora_core.music_artists SET tracks_count = 0")
            .execute(&self.pool)
            .await?;
        sqlx::query(
            r#"
            UPDATE flora_core.music_artists AS a
            SET tracks_count = sub.c
            FROM (
                SELECT artist_uuid, COUNT(DISTINCT track_uuid)::int AS c
                FROM flora_core.music_track_artists
                GROUP BY artist_uuid
            ) AS sub
            WHERE a.artist_uuid = sub.artist_uuid
            "#,
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_orphaned_artists(
        &self,
        created_before: DateTime<Utc>,
    ) -> Result<u64, sqlx::Error> {
        let ids: Vec<(Uuid,)> = sqlx::query_as(
            r#"
            SELECT a.artist_uuid
            FROM flora_core.music_artists a
            WHERE a.tracks_count = 0
              AND a.created_at < $1
              AND NOT EXISTS (
                SELECT 1 FROM flora_core.music_track_artists ta
                WHERE ta.artist_uuid = a.artist_uuid
              )
            "#,
        )
        .bind(created_before)
        .fetch_all(&self.pool)
        .await?;
        if ids.is_empty() {
            return Ok(0);
        }
        let uuids: Vec<Uuid> = ids.into_iter().map(|(id,)| id).collect();
        let result = sqlx::query(
            r#"
            DELETE FROM flora_core.music_artists
            WHERE artist_uuid = ANY($1)
            "#,
        )
        .bind(&uuids)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }
}

#[derive(Debug, Clone)]
pub struct NewTrackRow {
    pub track_uuid: Uuid,
    pub owner_user_uuid: Uuid,
    pub scope: i32,
    pub title: String,
    pub artist_display: String,
    pub tags: Option<String>,
    pub genre_id: Option<String>,
    pub license_id: Option<String>,
    pub cover_color_id: Option<String>,
    pub track_kind_id: Option<String>,
    pub content_type: String,
    pub audio_data: Vec<u8>,
    pub cover_data: Option<Vec<u8>>,
    pub cover_content_type: Option<String>,
    pub duration_ms: i32,
    pub file_size_bytes: i64,
    pub published_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct NewTrackArtistRow {
    pub music_track_artist_uuid: Uuid,
    pub track_uuid: Uuid,
    pub artist_uuid: Uuid,
    pub role: i32,
    pub joiner_before: i32,
    pub sort_order: i32,
}

enum OrderBy {
    PublishedAt,
    CreatedThenPublished,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ArtistListRow {
    pub artist_uuid: Uuid,
    pub display_name: String,
    pub linked_user_uuid: Option<Uuid>,
    pub created_by_user_uuid: Uuid,
    pub tracks_count: i32,
    pub has_cover_image: bool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MediaBlobRow {
    pub data: Vec<u8>,
    pub content_type: String,
}

pub fn joiner_to_wire(joiner: i32) -> &'static str {
    match joiner {
        1 => "And",
        2 => "Ft",
        3 => "Vs",
        4 => "Prod",
        5 => "Mix",
        6 => "Remix",
        7 => "Edit",
        8 => "Pres",
        _ => "None",
    }
}

pub fn scope_to_wire(scope: i32) -> &'static str {
    if scope == 1 { "platform" } else { "personal" }
}
