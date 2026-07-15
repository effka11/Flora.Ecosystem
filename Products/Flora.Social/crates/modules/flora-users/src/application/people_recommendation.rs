//! FIRA-P рекомендации людей — паритет `UserRecommendationService.cs`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use fira_core::people::{PeopleCandidate, UserRecommendationOptions, rank};
use flora_users_contracts::FollowGraphReader;
use uuid::Uuid;

use crate::infrastructure::recommendation::{
    RecommendationCandidateRow, SqlUserRecommendationQueries,
};

#[derive(Debug, Clone)]
pub struct RecommendedUser {
    pub user_uuid: Uuid,
    pub display_name: String,
    pub avatar_uuid: Option<Uuid>,
    pub follower_count: i32,
}

#[derive(Debug, Clone)]
struct PeopleSnapshot {
    full_list: Vec<RecommendedUser>,
    generated_at: DateTime<Utc>,
}

struct CacheEntry {
    snapshot: PeopleSnapshot,
    expires_at: Instant,
}

pub struct PeopleRecommendationService {
    queries: Arc<SqlUserRecommendationQueries>,
    follow: Arc<dyn FollowGraphReader>,
    options: UserRecommendationOptions,
    cache: Mutex<HashMap<Uuid, CacheEntry>>,
}

impl PeopleRecommendationService {
    pub fn new(
        queries: Arc<SqlUserRecommendationQueries>,
        follow: Arc<dyn FollowGraphReader>,
    ) -> Self {
        Self {
            queries,
            follow,
            options: UserRecommendationOptions::default(),
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn invalidate(&self, user_uuid: Uuid) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.remove(&user_uuid);
        }
    }

    pub async fn get_recommended(
        &self,
        user_uuid: Uuid,
        take: i32,
    ) -> Result<(Vec<RecommendedUser>, DateTime<Utc>, DateTime<Utc>), String> {
        let take = take.clamp(1, 100);
        let snapshot = self.get_or_compute_snapshot(user_uuid).await?;
        let ttl_secs = i64::from(self.options.cache_ttl_seconds.max(10));
        let expires_at = snapshot.generated_at + chrono::Duration::seconds(ttl_secs);
        let list = snapshot.full_list.into_iter().take(take as usize).collect();
        Ok((list, snapshot.generated_at, expires_at))
    }

    async fn get_or_compute_snapshot(&self, user_uuid: Uuid) -> Result<PeopleSnapshot, String> {
        let ttl = Duration::from_secs(self.options.cache_ttl_seconds.max(10) as u64);
        if let Ok(cache) = self.cache.lock()
            && let Some(entry) = cache.get(&user_uuid)
            && entry.expires_at > Instant::now()
        {
            return Ok(entry.snapshot.clone());
        }

        let now_utc = Utc::now();
        let following = self
            .follow
            .following_user_ids(user_uuid)
            .await
            .map_err(|e| e.to_string())?;
        let rows = self
            .queries
            .get_candidates(user_uuid, &following)
            .await
            .map_err(|e| e.to_string())?;

        let candidates: Vec<PeopleCandidate> = rows.iter().map(row_to_candidate).collect();
        let avatar_by: HashMap<Uuid, Option<Uuid>> =
            rows.iter().map(|r| (r.user_uuid, r.avatar_uuid)).collect();
        let ranked = rank(&candidates, &self.options, now_utc);
        let full_list: Vec<RecommendedUser> = ranked
            .into_iter()
            .map(|c| RecommendedUser {
                user_uuid: c.user_uuid,
                display_name: c.display_name,
                avatar_uuid: avatar_by.get(&c.user_uuid).copied().flatten(),
                follower_count: c.follower_count,
            })
            .collect();

        let snapshot = PeopleSnapshot {
            full_list,
            generated_at: now_utc,
        };
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(
                user_uuid,
                CacheEntry {
                    snapshot: snapshot.clone(),
                    expires_at: Instant::now() + ttl,
                },
            );
        }
        Ok(snapshot)
    }
}

fn row_to_candidate(row: &RecommendationCandidateRow) -> PeopleCandidate {
    PeopleCandidate {
        user_uuid: row.user_uuid,
        display_name: row.display_name.clone(),
        follower_count: row.follower_count,
        followed_by_following_count: row.followed_by_following_count,
        updated_at: row.updated_at,
    }
}
