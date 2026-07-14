//! sqlx-репозиторий Music (чтение). Схема `flora_core`, таблицы модуля без изменений.

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
