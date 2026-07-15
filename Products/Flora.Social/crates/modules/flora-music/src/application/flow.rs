//! GET /api/music/flow — FIRA-M wave (HTTP + cache + exploration; scorer в fira_core).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use flora_music_contracts::MusicFlowWaveDto;
use uuid::Uuid;

use crate::application::recommendations::{
    GenreWeights, MusicFlowCandidate, MusicRecommendationOptions, rank,
};
use crate::application::time::format_utc;
use crate::application::tracks::TrackService;
use crate::infrastructure::repo::{MusicRepo, TrackListRow};

struct Snapshot {
    ranked: Vec<TrackListRow>,
    generated_at: DateTime<Utc>,
}

struct CacheEntry {
    snapshot: Arc<Snapshot>,
    expires_at: Instant,
}

pub struct FlowService {
    repo: Arc<MusicRepo>,
    tracks: Arc<TrackService>,
    options: MusicRecommendationOptions,
    cache: Mutex<HashMap<String, CacheEntry>>,
}

impl FlowService {
    pub fn new(repo: Arc<MusicRepo>, tracks: Arc<TrackService>) -> Self {
        Self {
            repo,
            tracks,
            options: MusicRecommendationOptions::default(),
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub async fn get_wave(
        &self,
        user: Uuid,
        take: i32,
        exclude: &[Uuid],
        genre_id: Option<&str>,
        subgenre_id: Option<&str>,
    ) -> Result<MusicFlowWaveDto, sqlx::Error> {
        let take = take.clamp(1, 50);
        let exclude: HashSet<Uuid> = exclude.iter().copied().collect();
        let snapshot = self
            .get_or_compute_snapshot(user, genre_id, subgenre_id)
            .await?;

        let available: Vec<TrackListRow> = snapshot
            .ranked
            .iter()
            .filter(|r| !exclude.contains(&r.track_uuid))
            .cloned()
            .collect();

        let batch = pick_wave_batch(&available, take, self.options.exploration_quota);
        let tracks = self.tracks.map_platform_rows(user, batch).await?;

        let ttl = Duration::from_secs(self.options.cache_ttl_seconds.max(10) as u64);
        let expires_at =
            snapshot.generated_at + chrono::Duration::from_std(ttl).unwrap_or_default();

        Ok(MusicFlowWaveDto {
            tracks,
            generated_at: format_utc(snapshot.generated_at),
            expires_at: format_utc(expires_at),
        })
    }

    async fn get_or_compute_snapshot(
        &self,
        user: Uuid,
        genre_id: Option<&str>,
        subgenre_id: Option<&str>,
    ) -> Result<Arc<Snapshot>, sqlx::Error> {
        let key = cache_key(user, genre_id, subgenre_id);
        if let Ok(guard) = self.cache.lock()
            && let Some(entry) = guard.get(&key)
            && entry.expires_at > Instant::now()
        {
            return Ok(entry.snapshot.clone());
        }

        let limit = self.options.max_candidates;
        let rows = self
            .repo
            .list_published_platform_candidates_by_scope(genre_id, subgenre_id, limit)
            .await?;
        let weight_pairs = self.repo.get_user_genre_weights(user).await?;
        let weights = GenreWeights::from_pairs(weight_pairs);
        let now = Utc::now();

        let candidates: Vec<MusicFlowCandidate> = rows
            .iter()
            .filter_map(|r| {
                let published_at = r.published_at?;
                Some(MusicFlowCandidate {
                    track_uuid: r.track_uuid,
                    title: r.title.clone(),
                    genre_id: r.genre_id.clone(),
                    published_at,
                })
            })
            .collect();

        let ranked_ids: Vec<Uuid> = rank(&candidates, &weights, &self.options, now)
            .into_iter()
            .map(|c| c.track_uuid)
            .collect();

        let by_id: HashMap<Uuid, TrackListRow> =
            rows.into_iter().map(|r| (r.track_uuid, r)).collect();
        let ranked: Vec<TrackListRow> = ranked_ids
            .into_iter()
            .filter_map(|id| by_id.get(&id).cloned())
            .collect();

        let snapshot = Arc::new(Snapshot {
            ranked,
            generated_at: now,
        });

        let ttl = Duration::from_secs(self.options.cache_ttl_seconds.max(10) as u64);
        if let Ok(mut guard) = self.cache.lock() {
            guard.insert(
                key,
                CacheEntry {
                    snapshot: snapshot.clone(),
                    expires_at: Instant::now() + ttl,
                },
            );
        }

        Ok(snapshot)
    }
}

fn cache_key(user: Uuid, genre_id: Option<&str>, subgenre_id: Option<&str>) -> String {
    let genre_part = normalize_scope_part(genre_id);
    let subgenre_part = normalize_scope_part(subgenre_id);
    format!(
        "flora:fira-m:v1:{}:{genre_part}:{subgenre_part}",
        user.as_simple()
    )
}

fn normalize_scope_part(raw: Option<&str>) -> String {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => s.to_lowercase(),
        None => "_".to_string(),
    }
}

/// MidpointRounding.ToEven for exploration count.
pub fn round_dotnet_to_even(x: f64) -> i32 {
    let floor = x.floor();
    let frac = x - floor;
    if frac < 0.5 {
        floor as i32
    } else if frac > 0.5 {
        (floor + 1.0) as i32
    } else {
        let f = floor as i64;
        if f % 2 == 0 { f as i32 } else { (f + 1) as i32 }
    }
}

pub fn pick_wave_batch(
    ranked: &[TrackListRow],
    take: i32,
    exploration_quota: f64,
) -> Vec<TrackListRow> {
    let take = take as usize;
    if ranked.len() <= take {
        return ranked.to_vec();
    }
    let quota = exploration_quota.clamp(0.0, 0.5);
    let exploration_count = round_dotnet_to_even(take as f64 * quota).max(0) as usize;
    let exploration_count = exploration_count.min(take);
    let main_count = take - exploration_count;
    let main: Vec<TrackListRow> = ranked.iter().take(main_count).cloned().collect();
    let main_ids: HashSet<Uuid> = main.iter().map(|r| r.track_uuid).collect();

    let mut exploration_pool: Vec<TrackListRow> = ranked
        .iter()
        .skip(main_count)
        .filter(|r| !main_ids.contains(&r.track_uuid))
        .cloned()
        .collect();
    shuffle(&mut exploration_pool);
    let exploration: Vec<TrackListRow> = exploration_pool
        .into_iter()
        .take(exploration_count)
        .collect();

    main.into_iter().chain(exploration).collect()
}

fn shuffle<T>(items: &mut [T]) {
    for i in (1..items.len()).rev() {
        let mut buf = [0u8; 8];
        let _ = getrandom::fill(&mut buf);
        let j = (u64::from_le_bytes(buf) as usize) % (i + 1);
        items.swap(i, j);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exploration_sizes_for_default_quota() {
        // take=20, ε=0.15 → 3.0 → ToEven → 3 exploration, 17 main
        assert_eq!(round_dotnet_to_even(20.0 * 0.15), 3);
        let rows: Vec<TrackListRow> = (0..100)
            .map(|i| TrackListRow {
                track_uuid: Uuid::from_u128(i),
                owner_user_uuid: Uuid::nil(),
                scope: 1,
                title: format!("t{i}"),
                artist_display: "a".into(),
                tags: None,
                genre_id: None,
                license_id: None,
                cover_color_id: None,
                track_kind_id: None,
                has_cover_image: false,
                duration_ms: 1,
                created_at: Utc::now(),
                published_at: Some(Utc::now()),
            })
            .collect();
        let batch = pick_wave_batch(&rows, 20, 0.15);
        assert_eq!(batch.len(), 20);
        let main_ids: HashSet<_> = rows[..17].iter().map(|r| r.track_uuid).collect();
        assert!(batch[..17].iter().all(|r| main_ids.contains(&r.track_uuid)));
    }
}
