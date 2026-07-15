//! FIRA-C рекомендации сообществ — порт `CommunityRecommendationService.cs`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use fira_core::communities::{CommunityCandidate, CommunityRecommendationOptions, score};
use flora_shared::ordinal::cmp_ordinal_ignore_case;
use flora_users_contracts::FollowGraphReader;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::application::time::format_utc;
use crate::infrastructure::repo::{ContentRepo, RecommendationCandidateRow};

#[derive(Debug, Clone)]
struct CommunitySnapshot {
    items: Vec<Value>,
    generated_at: DateTime<Utc>,
}

struct CacheEntry {
    snapshot: CommunitySnapshot,
    expires_at: Instant,
}

pub struct CommunityRecommendationService {
    repo: Arc<ContentRepo>,
    follow: Arc<dyn FollowGraphReader>,
    options: CommunityRecommendationOptions,
    cache: Mutex<HashMap<Uuid, CacheEntry>>,
}

impl CommunityRecommendationService {
    pub fn new(repo: Arc<ContentRepo>, follow: Arc<dyn FollowGraphReader>) -> Self {
        Self {
            repo,
            follow,
            options: CommunityRecommendationOptions::default(),
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn invalidate(&self, user_uuid: Uuid) {
        if let Ok(mut c) = self.cache.lock() {
            c.remove(&user_uuid);
        }
    }

    pub async fn get_recommended(&self, user_uuid: Uuid, take: i32) -> Result<Value, String> {
        let take = take.clamp(1, 100);
        let snapshot = self.get_or_compute_snapshot(user_uuid).await?;
        let items: Vec<Value> = snapshot.items.into_iter().take(take as usize).collect();
        let ttl = self.options.cache_ttl_seconds.max(10);
        let expires_at = snapshot.generated_at + chrono::Duration::seconds(i64::from(ttl));
        Ok(json!({
            "items": items,
            "generatedAt": format_utc(snapshot.generated_at),
            "expiresAt": format_utc(expires_at),
        }))
    }

    async fn get_or_compute_snapshot(&self, user_uuid: Uuid) -> Result<CommunitySnapshot, String> {
        let ttl = Duration::from_secs(self.options.cache_ttl_seconds.max(10) as u64);
        if let Ok(cache) = self.cache.lock() {
            if let Some(entry) = cache.get(&user_uuid)
                && entry.expires_at > Instant::now()
            {
                return Ok(entry.snapshot.clone());
            }
        }

        let now_utc = Utc::now();
        let following = self.follow.following_user_ids(user_uuid).await?;
        let activity_days = self.options.activity_days.max(1);
        let activity_since = now_utc - chrono::Duration::days(i64::from(activity_days));
        let rows = self
            .repo
            .recommendation_candidates(user_uuid, &following, activity_since)
            .await
            .map_err(|e| e.to_string())?;

        let mut scored: Vec<(f64, RecommendationCandidateRow)> = rows
            .into_iter()
            .map(|row| {
                let candidate = CommunityCandidate {
                    community_id: row.community_id,
                    name: row.name.clone(),
                    created_at: row.created_at,
                    member_count: row.member_count,
                    recent_post_count: row.recent_post_count,
                    followed_members_count: row.followed_members_count,
                };
                (score(&candidate, &self.options, now_utc), row)
            })
            .collect();
        scored.sort_by(|a, b| {
            b.0.total_cmp(&a.0)
                .then_with(|| cmp_ordinal_ignore_case(&a.1.name, &b.1.name))
        });

        let items: Vec<Value> = scored
            .into_iter()
            .map(|(_, row)| {
                json!({
                    "communityId": row.community_id,
                    "name": row.name,
                    "slug": row.slug,
                    "memberCount": row.member_count,
                    "avatarUuid": row.avatar_uuid,
                })
            })
            .collect();

        let snapshot = CommunitySnapshot {
            items,
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
