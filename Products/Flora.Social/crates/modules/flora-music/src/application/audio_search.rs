//! In-memory FSA-A host over published platform tracks (catalog-only).
//!
//! Граница: ядро FSA не знает SQL; Music владеет индексом и гидратацией DTO.
//! Personal (scope = 0) и unpublished platform в индекс не попадают.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::{DateTime, Utc};
use fsa_core::PersonalizationLevel;
use fsa_core::audio::{AudioQuery, AudioSearch, AudioTrack};
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

use crate::infrastructure::repo::{CreditRow, MusicRepo};

const COMPACT_TOMBSTONE_RATIO: f64 = 0.2;

#[derive(Clone)]
enum AudioOp {
    Upsert(AudioTrack),
    Remove(String),
}

#[derive(Clone)]
pub struct AudioSearchHost {
    index: Arc<RwLock<AudioSearch>>,
    ready: Arc<AtomicBool>,
    pending: Arc<Mutex<Option<Vec<AudioOp>>>>,
}

impl AudioSearchHost {
    pub fn new() -> Self {
        Self {
            index: Arc::new(RwLock::new(AudioSearch::new())),
            ready: Arc::new(AtomicBool::new(false)),
            pending: Arc::new(Mutex::new(Some(Vec::new()))),
        }
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }

    /// Live upsert: only `scope = 1` AND `published_at IS NOT NULL`.
    #[allow(clippy::too_many_arguments)]
    pub async fn upsert_if_catalog(
        &self,
        track_uuid: Uuid,
        scope: i32,
        title: &str,
        artist_display: &str,
        artist_id: Option<Uuid>,
        tags: Option<&str>,
        genre_id: Option<&str>,
        published_at: Option<DateTime<Utc>>,
    ) {
        let Some(track) = catalog_audio_track(
            track_uuid,
            scope,
            title,
            artist_display,
            artist_id,
            tags,
            genre_id,
            published_at,
        ) else {
            self.apply(AudioOp::Remove(track_uuid.to_string())).await;
            return;
        };
        self.apply(AudioOp::Upsert(track)).await;
    }

    pub async fn remove(&self, track_uuid: Uuid) {
        self.apply(AudioOp::Remove(track_uuid.to_string())).await;
    }

    async fn apply(&self, op: AudioOp) {
        let mut pending = self.pending.lock().await;
        let mut guard = self.index.write().await;
        apply_audio_op(&mut guard, &op);
        compact_if_needed(&mut guard);
        if let Some(ops) = pending.as_mut() {
            ops.push(op);
        }
    }

    /// Until the SQL rebuild finishes, callers must treat the index as unusable.
    pub async fn search(&self, q: &str, offset: usize, limit: usize) -> Vec<Uuid> {
        if !self.is_ready() {
            return Vec::new();
        }
        let q = q.trim();
        if q.is_empty() {
            return Vec::new();
        }
        let now = Utc::now().timestamp();
        let mut query = AudioQuery::new(q, now);
        query.limit = limit;
        query.offset = offset;
        query.personalization = PersonalizationLevel::OFF;
        let guard = self.index.read().await;
        guard
            .search(&query, None)
            .hits
            .into_iter()
            .filter_map(|h| Uuid::parse_str(&h.id).ok())
            .collect()
    }

    pub async fn rebuild_from_repo(&self, repo: &MusicRepo) {
        let rows = match repo.list_platform_catalog().await {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!(error = %e, "music audio search rebuild failed to load catalog");
                return;
            }
        };
        let ids: Vec<Uuid> = rows.iter().map(|r| r.track_uuid).collect();
        let credits = match repo.list_credits_for_tracks(&ids).await {
            Ok(credits) => credits,
            Err(e) => {
                tracing::warn!(error = %e, "music audio search rebuild failed to load credits");
                return;
            }
        };
        let first_artist = first_artist_ids(&credits);
        let mut built = AudioSearch::new();
        for row in &rows {
            let artist_id = first_artist.get(&row.track_uuid).copied();
            let Some(track) = catalog_audio_track(
                row.track_uuid,
                row.scope,
                &row.title,
                &row.artist_display,
                artist_id,
                row.tags.as_deref(),
                row.genre_id.as_deref(),
                row.published_at,
            ) else {
                continue;
            };
            if let Err(e) = built.upsert(track) {
                tracing::warn!(error = %e, track = %row.track_uuid, "music audio search rebuild upsert failed");
            }
        }
        self.install_rebuilt(built).await;
    }

    async fn install_rebuilt(&self, mut built: AudioSearch) {
        let mut pending = self.pending.lock().await;
        if let Some(ops) = pending.as_ref() {
            for op in ops {
                apply_audio_op(&mut built, op);
            }
        }
        compact_if_needed(&mut built);
        let mut guard = self.index.write().await;
        *guard = built;
        *pending = None;
        drop(guard);
        self.ready.store(true, Ordering::Release);
    }
}

impl Default for AudioSearchHost {
    fn default() -> Self {
        Self::new()
    }
}

fn first_artist_ids(credits: &[CreditRow]) -> HashMap<Uuid, Uuid> {
    let mut map = HashMap::new();
    for c in credits {
        map.entry(c.track_uuid).or_insert(c.artist_uuid);
    }
    map
}

#[allow(clippy::too_many_arguments)]
fn catalog_audio_track(
    track_uuid: Uuid,
    scope: i32,
    title: &str,
    artist_display: &str,
    artist_id: Option<Uuid>,
    tags: Option<&str>,
    genre_id: Option<&str>,
    published_at: Option<DateTime<Utc>>,
) -> Option<AudioTrack> {
    if scope != 1 {
        return None;
    }
    let published_at = published_at?;
    Some(AudioTrack {
        id: track_uuid.to_string(),
        title: title.to_string(),
        artist_name: artist_display.to_string(),
        artist_id: artist_id.map(|id| id.to_string()).unwrap_or_default(),
        album: None,
        album_id: None,
        tags: tags
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| vec![s.to_string()])
            .unwrap_or_default(),
        genre: genre_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        explicit: false,
        published_at: published_at.timestamp(),
        popularity_rank: 0.0,
    })
}

fn apply_audio_op(search: &mut AudioSearch, op: &AudioOp) {
    match op {
        AudioOp::Upsert(track) => {
            if let Err(e) = search.upsert(track.clone()) {
                tracing::warn!(error = %e, "music audio search upsert failed");
            }
        }
        AudioOp::Remove(id) => {
            search.remove(id);
        }
    }
}

fn compact_if_needed(search: &mut AudioSearch) {
    let tombs = search.engine().tombstones();
    if tombs == 0 {
        return;
    }
    let alive = search.len();
    let ratio = if alive == 0 {
        f64::INFINITY
    } else {
        tombs as f64 / alive as f64
    };
    if ratio > COMPACT_TOMBSTONE_RATIO {
        search.compact();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<F: std::future::Future>(fut: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime")
            .block_on(fut)
    }

    fn published_at() -> DateTime<Utc> {
        DateTime::<Utc>::from_timestamp(1_700_000_000, 0).expect("timestamp")
    }

    #[test]
    fn personal_and_unpublished_tracks_are_not_in_results() {
        let host = AudioSearchHost::new();
        host.ready.store(true, Ordering::Release);
        let personal = Uuid::from_u128(1);
        let unpublished = Uuid::from_u128(2);
        let published = Uuid::from_u128(3);
        block_on(async {
            host.upsert_if_catalog(
                personal,
                0,
                "xylophone personal",
                "Solo",
                None,
                None,
                None,
                None,
            )
            .await;
            host.upsert_if_catalog(
                unpublished,
                1,
                "xylophone draft",
                "Band",
                None,
                None,
                None,
                None,
            )
            .await;
            host.upsert_if_catalog(
                published,
                1,
                "xylophone live",
                "Band",
                None,
                None,
                None,
                Some(published_at()),
            )
            .await;
            let hits = host.search("xylophone", 0, 20).await;
            assert_eq!(hits, vec![published]);
        });
    }

    #[test]
    fn search_before_ready_returns_empty() {
        let host = AudioSearchHost::new();
        let published = Uuid::from_u128(9);
        block_on(async {
            host.upsert_if_catalog(
                published,
                1,
                "xylophone live",
                "Band",
                None,
                None,
                None,
                Some(published_at()),
            )
            .await;
            assert!(host.search("xylophone", 0, 20).await.is_empty());
            host.ready.store(true, Ordering::Release);
            assert_eq!(host.search("xylophone", 0, 20).await, vec![published]);
        });
    }

    #[test]
    fn install_rebuilt_replays_pending_catalog_upsert() {
        let host = AudioSearchHost::new();
        let published = Uuid::from_u128(11);
        block_on(async {
            host.upsert_if_catalog(
                published,
                1,
                "xylophone live",
                "Band",
                None,
                None,
                None,
                Some(published_at()),
            )
            .await;
            host.install_rebuilt(AudioSearch::new()).await;
            assert!(host.is_ready());
            assert_eq!(host.search("xylophone", 0, 20).await, vec![published]);
        });
    }
}
