//! FIRA-F + хронологические подписки — порт `FeedRecommendationService.cs`.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use fira_core::feed::{
    FeedCandidate, FiraFeedConfig, apply_author_diversity, apply_preferences, author_affinity,
    interleave_exploration, rank,
};
use fira_core::{FeedPreferences, SeenPostsMode};
use flora_users_contracts::{
    BidirectionalBlocklist, FollowGraphReader, ProfileAccess, ProfileAccessField,
};
use uuid::Uuid;

use crate::application::feed_controls::preferences_from_row;
use crate::infrastructure::repo::{ContentRepo, FeedPostLite};

/// Персональный контекст рекомендаций (§User Controls, FIRA-F v1.1).
struct Personalization {
    prefs: FeedPreferences,
    /// Посты «не интересно» — жёсткое исключение из рекомендательных пулов.
    not_interested: HashSet<Uuid>,
    /// «не интересно» по авторам в окне interaction_history_days (мягкий штраф Score).
    not_interested_authors: HashMap<Uuid, i32>,
    /// Скрытые авторы — исключаются из рекомендаций (подписки не трогаем).
    hidden_authors: HashSet<Uuid>,
}

#[derive(Debug, Clone)]
pub struct FeedPage {
    pub post_uuids: Vec<Uuid>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
    pub generated_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
struct FeedSnapshot {
    post_uuids: Vec<Uuid>,
    generated_at: DateTime<Utc>,
}

struct CacheEntry {
    snapshot: FeedSnapshot,
    expires_at: Instant,
}

pub struct FeedService {
    repo: Arc<ContentRepo>,
    follow: Arc<dyn FollowGraphReader>,
    blocklist: Arc<dyn BidirectionalBlocklist>,
    profile_access: Arc<dyn ProfileAccess>,
    fira: FiraFeedConfig,
    sub_following_days: i32,
    sub_max_candidates: i32,
    cache: Mutex<HashMap<Uuid, CacheEntry>>,
}

impl FeedService {
    pub fn new(
        repo: Arc<ContentRepo>,
        follow: Arc<dyn FollowGraphReader>,
        blocklist: Arc<dyn BidirectionalBlocklist>,
        profile_access: Arc<dyn ProfileAccess>,
    ) -> Self {
        Self {
            repo,
            follow,
            blocklist,
            profile_access,
            fira: FiraFeedConfig::default(),
            sub_following_days: 30,
            sub_max_candidates: 2000,
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn invalidate(&self, user_uuid: Uuid) {
        if let Ok(mut c) = self.cache.lock() {
            c.remove(&user_uuid);
        }
    }

    pub async fn get_feed(
        &self,
        user_uuid: Uuid,
        take: i32,
        cursor: Option<&str>,
        kind: Option<&str>,
        refresh: bool,
    ) -> Result<FeedPage, String> {
        let take = take.clamp(1, 50);
        let subscriptions = kind
            .map(|k| k.eq_ignore_ascii_case("subscriptions"))
            .unwrap_or(false);
        if subscriptions {
            self.subscriptions_feed(user_uuid, take, cursor).await
        } else {
            self.recommended_feed(user_uuid, take, cursor, refresh)
                .await
        }
    }

    pub async fn has_new(&self, user_uuid: Uuid, since: DateTime<Utc>) -> Result<bool, String> {
        let blocked = self
            .blocklist
            .blocked_user_ids_bidirectional(user_uuid)
            .await?
            .into_iter()
            .collect::<HashSet<_>>();
        let following: Vec<Uuid> = self
            .follow
            .following_user_ids(user_uuid)
            .await?
            .into_iter()
            .filter(|id| !blocked.contains(id))
            .collect();
        let visible_personal_authors = self
            .profile_access
            .accessible_owners(Some(user_uuid), &following, ProfileAccessField::Posts)
            .await?;
        self.repo
            .has_newer_posts(&following, &visible_personal_authors, since, user_uuid)
            .await
            .map_err(|e| e.to_string())
    }

    /// Настройки ленты пользователя (дефолты при отсутствии строки/незнакомых значениях).
    async fn load_preferences(&self, user_uuid: Uuid) -> Result<FeedPreferences, String> {
        Ok(self
            .repo
            .feed_settings(user_uuid)
            .await
            .map_err(|e| e.to_string())?
            .map(|row| preferences_from_row(&row))
            .unwrap_or_default())
    }

    async fn load_personalization(
        &self,
        user_uuid: Uuid,
        since_interaction: DateTime<Utc>,
    ) -> Result<Personalization, String> {
        let prefs = self.load_preferences(user_uuid).await?;
        let not_interested: HashSet<Uuid> = self
            .repo
            .not_interested_post_ids(user_uuid)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .collect();
        let not_interested_authors = self
            .repo
            .not_interested_author_counts(user_uuid, since_interaction)
            .await
            .map_err(|e| e.to_string())?;
        let hidden_authors: HashSet<Uuid> = self
            .repo
            .hidden_author_ids(user_uuid)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .collect();
        Ok(Personalization {
            prefs,
            not_interested,
            not_interested_authors,
            hidden_authors,
        })
    }

    async fn subscriptions_feed(
        &self,
        user_uuid: Uuid,
        take: i32,
        cursor: Option<&str>,
    ) -> Result<FeedPage, String> {
        let blocked = self
            .blocklist
            .blocked_user_ids_bidirectional(user_uuid)
            .await?
            .into_iter()
            .collect::<HashSet<_>>();
        let following: Vec<Uuid> = self
            .follow
            .following_user_ids(user_uuid)
            .await?
            .into_iter()
            .filter(|id| !blocked.contains(id))
            .collect();
        let now = Utc::now();
        if following.is_empty() {
            return Ok(empty_page(now));
        }

        let show_reposts = self.load_preferences(user_uuid).await?.show_reposts;
        let since = now - chrono::Duration::days(i64::from(self.subscription_window_days()));
        let max_candidates = i64::from(self.subscription_posts_take_limit());

        let author_posts = self
            .repo
            .posts_by_authors_since(&following, since, max_candidates, user_uuid)
            .await
            .map_err(|e| e.to_string())?;
        let author_post_ids: HashSet<Uuid> = author_posts.iter().map(|p| p.post_uuid).collect();

        let first_reposts = if show_reposts {
            self.repo
                .first_reposts_from_users(&following, since, max_candidates)
                .await
                .map_err(|e| e.to_string())?
        } else {
            Vec::new()
        };
        let repost_only: Vec<Uuid> = first_reposts
            .iter()
            .map(|(id, _)| *id)
            .filter(|id| !author_post_ids.contains(id))
            .collect();

        let mut timeline: HashMap<Uuid, DateTime<Utc>> = HashMap::new();
        for post in &author_posts {
            timeline.insert(post.post_uuid, post.created_at);
        }
        let first_repost_at: HashMap<Uuid, DateTime<Utc>> = first_reposts.into_iter().collect();
        if !repost_only.is_empty() {
            let repost_posts = self
                .repo
                .posts_by_ids(&repost_only, user_uuid)
                .await
                .map_err(|e| e.to_string())?;
            for post in repost_posts {
                if let Some(at) = first_repost_at.get(&post.post_uuid) {
                    timeline.insert(post.post_uuid, *at);
                }
            }
        }

        let mut ordered: Vec<(Uuid, DateTime<Utc>)> = timeline.into_iter().collect();
        ordered.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let ordered_ids: Vec<Uuid> = ordered.into_iter().map(|(id, _)| id).collect();

        Ok(page_from_list(ordered_ids, take, cursor, now, now))
    }

    async fn recommended_feed(
        &self,
        user_uuid: Uuid,
        take: i32,
        cursor: Option<&str>,
        force_refresh: bool,
    ) -> Result<FeedPage, String> {
        let offset = parse_cursor(cursor);
        let snapshot = if force_refresh && offset == 0 {
            self.refresh_snapshot(user_uuid).await?
        } else {
            self.get_or_compute_snapshot(user_uuid).await?
        };
        let page: Vec<Uuid> = snapshot
            .post_uuids
            .iter()
            .skip(offset)
            .take(take as usize)
            .copied()
            .collect();
        let next = if offset + page.len() < snapshot.post_uuids.len() {
            Some(encode_cursor(offset + take as usize))
        } else {
            None
        };
        let expires = snapshot.generated_at
            + chrono::Duration::seconds(i64::from(self.fira.cache_ttl_seconds));
        Ok(FeedPage {
            post_uuids: page,
            next_cursor: next.clone(),
            has_more: next.is_some(),
            generated_at: snapshot.generated_at,
            expires_at: expires,
        })
    }

    async fn get_or_compute_snapshot(&self, user_uuid: Uuid) -> Result<FeedSnapshot, String> {
        if self.fira.enable_cache
            && let Ok(cache) = self.cache.lock()
            && let Some(entry) = cache.get(&user_uuid)
            && Instant::now() < entry.expires_at
        {
            return Ok(entry.snapshot.clone());
        }
        let list = self.compute_fira_feed(user_uuid).await?;
        self.store_snapshot(user_uuid, list)
    }

    async fn refresh_snapshot(&self, user_uuid: Uuid) -> Result<FeedSnapshot, String> {
        let previous_top: Option<Vec<Uuid>> = if self.fira.enable_cache {
            self.cache.lock().ok().and_then(|c| {
                c.get(&user_uuid).map(|e| {
                    e.snapshot
                        .post_uuids
                        .iter()
                        .take(self.fira.refresh_shuffle_window.max(1) as usize)
                        .copied()
                        .collect()
                })
            })
        } else {
            None
        };
        let mut fresh = self.compute_fira_feed(user_uuid).await?;
        if let Some(prev) = previous_top
            && !prev.is_empty()
        {
            self.apply_refresh_shuffle(user_uuid, &prev, &mut fresh)
                .await?;
        }
        self.store_snapshot(user_uuid, fresh)
    }

    fn store_snapshot(
        &self,
        user_uuid: Uuid,
        post_uuids: Vec<Uuid>,
    ) -> Result<FeedSnapshot, String> {
        let generated_at = Utc::now();
        let snapshot = FeedSnapshot {
            post_uuids,
            generated_at,
        };
        if self.fira.enable_cache {
            let ttl = Duration::from_secs(self.fira.cache_ttl_seconds.max(10) as u64);
            if let Ok(mut cache) = self.cache.lock() {
                cache.insert(
                    user_uuid,
                    CacheEntry {
                        snapshot: snapshot.clone(),
                        expires_at: Instant::now() + ttl,
                    },
                );
            }
        }
        Ok(snapshot)
    }

    async fn apply_refresh_shuffle(
        &self,
        user_uuid: Uuid,
        previous_top: &[Uuid],
        fresh: &mut [Uuid],
    ) -> Result<(), String> {
        if fresh.is_empty() {
            return Ok(());
        }
        let window = (self.fira.refresh_shuffle_window.max(1) as usize).min(fresh.len());
        let meta_posts = self
            .repo
            .posts_by_ids(&fresh[..window], user_uuid)
            .await
            .map_err(|e| e.to_string())?;
        let meta: HashMap<Uuid, FeedPostLite> =
            meta_posts.into_iter().map(|p| (p.post_uuid, p)).collect();
        let probs = &self.fira.refresh_position_swap_probabilities;
        let now = Utc::now();

        for i in 0..window {
            if i > 0 {
                let p = probs.get(i).copied().unwrap_or(0.0);
                if random_f64() >= p {
                    continue;
                }
            }
            let prev_id = previous_top.get(i).copied().unwrap_or(Uuid::nil());
            if prev_id.is_nil() || fresh[i] != prev_id {
                continue;
            }
            if is_protected_own(
                &meta,
                fresh[i],
                user_uuid,
                now,
                self.fira.refresh_own_post_protect_minutes,
            ) {
                continue;
            }
            let candidate = fresh
                .iter()
                .enumerate()
                .skip(i + 1)
                .find(|(_, id)| **id != prev_id);
            if let Some((j, _)) = candidate {
                fresh.swap(i, j);
            }
        }
        Ok(())
    }

    fn subscription_window_days(&self) -> i32 {
        self.fira
            .following_window_days
            .max(self.sub_following_days)
            .max(30)
    }

    fn subscription_posts_take_limit(&self) -> i32 {
        self.sub_max_candidates.clamp(50, 5000)
    }

    fn min_feed_size(&self) -> usize {
        self.fira.min_feed_size.clamp(1, self.fira.max_candidates) as usize
    }

    fn pool_limit(&self, ratio: f64) -> i64 {
        (f64::from(self.fira.max_candidates) * ratio) as i64
    }

    async fn compute_fira_feed(&self, user_uuid: Uuid) -> Result<Vec<Uuid>, String> {
        let now = Utc::now();
        let window_days = self.subscription_window_days();
        let since_sub = now - chrono::Duration::days(i64::from(window_days));
        let since_trending =
            now - chrono::Duration::days(i64::from(self.fira.trending_window_days));
        let since_interaction =
            now - chrono::Duration::days(i64::from(self.fira.interaction_history_days));

        let personal = self
            .load_personalization(user_uuid, since_interaction)
            .await?;
        let mut effective = self.fira.clone();
        apply_preferences(&mut effective, &personal.prefs);
        let not_interested = &personal.not_interested;

        let mut blocked: HashSet<Uuid> = self
            .blocklist
            .blocked_user_ids_bidirectional(user_uuid)
            .await?
            .into_iter()
            .collect();
        // Скрытые авторы — та же семантика видимости для рекомендаций, что и блок.
        blocked.extend(personal.hidden_authors.iter().copied());
        let following: Vec<Uuid> = self
            .follow
            .following_user_ids(user_uuid)
            .await?
            .into_iter()
            .filter(|id| !blocked.contains(id))
            .collect();
        let following_set: HashSet<Uuid> = following.iter().copied().collect();

        let subscription_posts = if following.is_empty() {
            Vec::new()
        } else {
            self.repo
                .posts_by_authors_since(
                    &following,
                    since_sub,
                    i64::from(self.subscription_posts_take_limit()),
                    user_uuid,
                )
                .await
                .map_err(|e| e.to_string())?
        };

        let second_degree: Vec<Uuid> = if following_set.is_empty() {
            Vec::new()
        } else {
            let ids: Vec<Uuid> = following_set.iter().copied().collect();
            self.follow
                .following_user_ids_for_followers(&ids, user_uuid)
                .await?
                .into_iter()
                .filter(|id| !blocked.contains(id))
                .collect()
        };

        let mut pool: HashMap<Uuid, (FeedPostLite, f64)> = HashMap::new();
        merge_pool(
            &mut pool,
            subscription_posts
                .iter()
                .take(self.pool_limit(0.50) as usize)
                .cloned(),
            1.0,
            &blocked,
            not_interested,
        );

        if !second_degree.is_empty() {
            let from2 = self
                .repo
                .posts_by_authors_since(&second_degree, since_sub, self.pool_limit(0.15), user_uuid)
                .await
                .map_err(|e| e.to_string())?;
            merge_pool(&mut pool, from2, 0.4, &blocked, not_interested);
        }

        let mut trending_ids = self
            .repo
            .trending_post_ids(
                since_trending,
                self.pool_limit(0.15),
                &following_set.iter().copied().collect::<Vec<_>>(),
                user_uuid,
            )
            .await
            .map_err(|e| e.to_string())?;
        if trending_ids.is_empty() {
            trending_ids = self
                .repo
                .trending_post_ids(
                    since_sub,
                    self.pool_limit(0.15),
                    &following_set.iter().copied().collect::<Vec<_>>(),
                    user_uuid,
                )
                .await
                .map_err(|e| e.to_string())?;
        }
        if trending_ids.is_empty() {
            trending_ids = self
                .repo
                .trending_post_ids(
                    now - chrono::Duration::days(30),
                    self.pool_limit(0.15),
                    &following_set.iter().copied().collect::<Vec<_>>(),
                    user_uuid,
                )
                .await
                .map_err(|e| e.to_string())?;
        }
        if !trending_ids.is_empty() {
            let trending = self
                .repo
                .posts_by_ids(&trending_ids, user_uuid)
                .await
                .map_err(|e| e.to_string())?;
            merge_pool(&mut pool, trending, 0.25, &blocked, not_interested);
        }

        if personal.prefs.community_posts {
            let community_posts = self
                .repo
                .community_posts_for_user(user_uuid, since_sub, self.pool_limit(0.20))
                .await
                .map_err(|e| e.to_string())?;
            merge_pool(&mut pool, community_posts, 0.6, &blocked, not_interested);
        }

        let followed_reposts = if personal.prefs.show_reposts {
            self.repo
                .reposts_from_users(&following, since_sub, self.pool_limit(0.10))
                .await
                .map_err(|e| e.to_string())?
        } else {
            Vec::new()
        };
        let repost_post_ids: Vec<Uuid> = followed_reposts
            .iter()
            .map(|(id, _)| *id)
            .filter(|id| !pool.contains_key(id))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        if !repost_post_ids.is_empty() {
            let rp = self
                .repo
                .posts_by_ids(&repost_post_ids, user_uuid)
                .await
                .map_err(|e| e.to_string())?;
            merge_pool(&mut pool, rp, 0.6, &blocked, not_interested);
        }
        let mut reposted_by_followed: HashMap<Uuid, i32> = HashMap::new();
        for (post_id, _) in &followed_reposts {
            *reposted_by_followed.entry(*post_id).or_insert(0) += 1;
        }

        // Режим Hide: просмотренные исключаются из пула до добора и скоринга.
        let seen_posts: HashSet<Uuid> = if personal.prefs.seen_posts == SeenPostsMode::Show {
            HashSet::new()
        } else {
            let pool_ids: Vec<Uuid> = pool.keys().copied().collect();
            self.repo
                .seen_post_ids_among(user_uuid, &pool_ids)
                .await
                .map_err(|e| e.to_string())?
        };
        if personal.prefs.seen_posts == SeenPostsMode::Hide {
            pool.retain(|id, _| !seen_posts.contains(id));
        }

        if pool.len() < self.min_feed_size() {
            merge_pool(
                &mut pool,
                subscription_posts
                    .iter()
                    .filter(|p| {
                        personal.prefs.seen_posts != SeenPostsMode::Hide
                            || !seen_posts.contains(&p.post_uuid)
                    })
                    .cloned(),
                1.0,
                &blocked,
                not_interested,
            );
        }
        if pool.len() < self.min_feed_size() {
            let exclude: Vec<Uuid> = pool.keys().copied().collect();
            let exploration = self
                .get_exploration_ids(
                    user_uuid,
                    since_sub,
                    &exclude,
                    &blocked,
                    not_interested,
                    self.min_feed_size() - pool.len(),
                )
                .await?;
            if !exploration.is_empty() {
                let posts = self
                    .repo
                    .posts_by_ids(&exploration, user_uuid)
                    .await
                    .map_err(|e| e.to_string())?;
                merge_pool(&mut pool, posts, 0.15, &blocked, not_interested);
            }
        }

        if pool.is_empty() {
            return self
                .build_cold_start(user_uuid, since_sub, &blocked, not_interested)
                .await;
        }

        let post_ids: Vec<Uuid> = pool.keys().copied().collect();
        let author_ids: Vec<Uuid> = pool
            .values()
            .map(|(p, _)| p.author_user_uuid)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();

        let engagement = self
            .repo
            .engagement_48h(&post_ids)
            .await
            .map_err(|e| e.to_string())?;
        let follower_counts = self.follow.follower_counts(&author_ids).await?;
        let follower_map: HashMap<Uuid, i32> = follower_counts.into_iter().collect();
        let author_scores = self
            .repo
            .author_interaction_scores(user_uuid, &author_ids, since_interaction)
            .await
            .map_err(|e| e.to_string())?;
        let followed_vec: Vec<Uuid> = following_set.iter().copied().collect();
        let followed_likers = if followed_vec.is_empty() {
            HashMap::new()
        } else {
            self.repo
                .followed_liker_counts(&post_ids, &followed_vec)
                .await
                .map_err(|e| e.to_string())?
        };

        let candidates: Vec<FeedCandidate> = pool
            .iter()
            .map(|(id, (post, pool_weight))| {
                let eng = engagement.get(id).copied().unwrap_or((0, 0, 0, 0));
                let raw = author_scores
                    .get(&post.author_user_uuid)
                    .copied()
                    .unwrap_or(0.0);
                FeedCandidate {
                    post_uuid: *id,
                    author_user_uuid: post.author_user_uuid,
                    created_at: post.created_at,
                    likes_48h: eng.0,
                    comments_48h: eng.1,
                    reposts_48h: eng.2,
                    views_48h: eng.3,
                    author_follower_count: *follower_map.get(&post.author_user_uuid).unwrap_or(&0),
                    author_affinity: author_affinity(raw, self.fira.author_affinity_scale),
                    followed_likers_count: *followed_likers.get(id).unwrap_or(&0),
                    followed_reposters_count: *reposted_by_followed.get(id).unwrap_or(&0),
                    pool_weight: *pool_weight,
                    seen: personal.prefs.seen_posts == SeenPostsMode::Demote
                        && seen_posts.contains(id),
                    author_not_interested_count: *personal
                        .not_interested_authors
                        .get(&post.author_user_uuid)
                        .unwrap_or(&0),
                }
            })
            .collect();

        let scored = rank(&candidates, &effective, now);
        let diversified = apply_author_diversity(&scored, effective.max_consecutive_same_author);

        let total_slots = self.fira.max_candidates as usize;
        let exploration_slots = (total_slots as f64 * effective.exploration_quota) as usize;
        let main_slots = total_slots.saturating_sub(exploration_slots);
        let main_ids: Vec<Uuid> = diversified
            .iter()
            .take(main_slots)
            .map(|c| c.post_uuid)
            .collect();
        let excluded: HashSet<Uuid> = main_ids.iter().copied().collect();
        let exclude_vec: Vec<Uuid> = excluded.iter().copied().collect();
        let exploration_ids = self
            .get_exploration_ids(
                user_uuid,
                since_sub,
                &exclude_vec,
                &blocked,
                not_interested,
                exploration_slots * 2,
            )
            .await?;
        let exploration_ids: Vec<Uuid> = exploration_ids
            .into_iter()
            .take(exploration_slots)
            .collect();
        let merged =
            interleave_exploration(main_ids, &exploration_ids, effective.exploration_quota);

        let own = self
            .repo
            .own_post_ids(user_uuid, 100)
            .await
            .map_err(|e| e.to_string())?;
        let own_set: HashSet<Uuid> = own.iter().copied().collect();
        let mut result: Vec<Uuid> = own
            .into_iter()
            .chain(merged.into_iter().filter(|id| !own_set.contains(id)))
            .collect();

        result = self
            .ensure_min_feed_size(
                user_uuid,
                result,
                &subscription_posts,
                since_sub,
                &blocked,
                not_interested,
            )
            .await?;
        Ok(result)
    }

    async fn build_cold_start(
        &self,
        user_uuid: Uuid,
        since_sub: DateTime<Utc>,
        blocked: &HashSet<Uuid>,
        not_interested: &HashSet<Uuid>,
    ) -> Result<Vec<Uuid>, String> {
        let own = self
            .repo
            .own_post_ids(user_uuid, 100)
            .await
            .map_err(|e| e.to_string())?;
        let exploration_take = self.pool_limit(0.15).clamp(20, 100) as usize;
        let exploration = self
            .get_exploration_ids(
                user_uuid,
                since_sub,
                &own,
                blocked,
                not_interested,
                exploration_take,
            )
            .await?;
        if own.is_empty() && exploration.is_empty() {
            return self
                .latest_visible_ids(
                    user_uuid,
                    blocked,
                    not_interested,
                    self.fira.max_candidates.min(50) as usize,
                )
                .await;
        }
        let own_set: HashSet<Uuid> = own.iter().copied().collect();
        let merged: Vec<Uuid> = own
            .into_iter()
            .chain(exploration.into_iter().filter(|id| !own_set.contains(id)))
            .collect();
        self.ensure_min_feed_size(user_uuid, merged, &[], since_sub, blocked, not_interested)
            .await
    }

    async fn ensure_min_feed_size(
        &self,
        user_uuid: Uuid,
        feed: Vec<Uuid>,
        subscription_posts: &[FeedPostLite],
        since_sub: DateTime<Utc>,
        blocked: &HashSet<Uuid>,
        not_interested: &HashSet<Uuid>,
    ) -> Result<Vec<Uuid>, String> {
        if feed.len() >= self.min_feed_size() {
            return Ok(feed);
        }
        let mut result = feed;
        let mut seen: HashSet<Uuid> = result.iter().copied().collect();

        let mut subs: Vec<&FeedPostLite> = subscription_posts.iter().collect();
        subs.sort_by_key(|b| std::cmp::Reverse(b.created_at));
        for post in subs {
            if blocked.contains(&post.author_user_uuid) || not_interested.contains(&post.post_uuid)
            {
                continue;
            }
            if seen.insert(post.post_uuid) {
                result.push(post.post_uuid);
            }
            if result.len() >= self.min_feed_size() {
                return Ok(result);
            }
        }

        let exclude: Vec<Uuid> = seen.iter().copied().collect();
        let exploration = self
            .get_exploration_ids(
                user_uuid,
                since_sub,
                &exclude,
                blocked,
                not_interested,
                self.min_feed_size() - result.len(),
            )
            .await?;
        for id in exploration {
            if seen.insert(id) {
                result.push(id);
            }
            if result.len() >= self.min_feed_size() {
                return Ok(result);
            }
        }

        if result.is_empty() {
            return self
                .latest_visible_ids(
                    user_uuid,
                    blocked,
                    not_interested,
                    self.fira.max_candidates.min(50) as usize,
                )
                .await;
        }

        if result.len() < self.min_feed_size() {
            let latest = self
                .latest_visible_ids(
                    user_uuid,
                    blocked,
                    not_interested,
                    self.fira.max_candidates.min(50) as usize,
                )
                .await?;
            for id in latest {
                if seen.insert(id) {
                    result.push(id);
                }
                if result.len() >= self.min_feed_size() {
                    break;
                }
            }
        }
        Ok(result)
    }

    async fn latest_visible_ids(
        &self,
        user_uuid: Uuid,
        blocked: &HashSet<Uuid>,
        not_interested: &HashSet<Uuid>,
        take: usize,
    ) -> Result<Vec<Uuid>, String> {
        let latest = self
            .repo
            .latest_posts(take as i64, user_uuid)
            .await
            .map_err(|e| e.to_string())?;
        Ok(latest
            .into_iter()
            .filter(|p| {
                !blocked.contains(&p.author_user_uuid) && !not_interested.contains(&p.post_uuid)
            })
            .map(|p| p.post_uuid)
            .collect())
    }

    async fn get_exploration_ids(
        &self,
        user_uuid: Uuid,
        primary_since: DateTime<Utc>,
        exclude: &[Uuid],
        blocked: &HashSet<Uuid>,
        not_interested: &HashSet<Uuid>,
        limit: usize,
    ) -> Result<Vec<Uuid>, String> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let windows = [
            primary_since,
            primary_since - chrono::Duration::days(23),
            DateTime::<Utc>::UNIX_EPOCH,
        ];
        let exclude_set: HashSet<Uuid> = exclude.iter().copied().collect();
        let exclude_vec: Vec<Uuid> = exclude_set.iter().copied().collect();
        for since in windows {
            let posts = self
                .repo
                .exploration_posts(since, &exclude_vec, limit as i64, user_uuid)
                .await
                .map_err(|e| e.to_string())?;
            let visible: Vec<Uuid> = posts
                .into_iter()
                .filter(|p| {
                    !blocked.contains(&p.author_user_uuid) && !not_interested.contains(&p.post_uuid)
                })
                .map(|p| p.post_uuid)
                .collect();
            if !visible.is_empty() {
                return Ok(visible);
            }
        }
        Ok(Vec::new())
    }
}

fn merge_pool(
    pool: &mut HashMap<Uuid, (FeedPostLite, f64)>,
    posts: impl IntoIterator<Item = FeedPostLite>,
    weight: f64,
    blocked: &HashSet<Uuid>,
    not_interested: &HashSet<Uuid>,
) {
    for post in posts {
        if blocked.contains(&post.author_user_uuid) || not_interested.contains(&post.post_uuid) {
            continue;
        }
        match pool.get(&post.post_uuid) {
            Some((_, existing)) if weight <= *existing => {}
            _ => {
                pool.insert(post.post_uuid, (post, weight));
            }
        }
    }
}

fn is_protected_own(
    meta: &HashMap<Uuid, FeedPostLite>,
    post_id: Uuid,
    user_uuid: Uuid,
    now: DateTime<Utc>,
    protect_minutes: i32,
) -> bool {
    let Some(post) = meta.get(&post_id) else {
        return false;
    };
    post.author_user_uuid == user_uuid
        && (now - post.created_at).num_minutes() < i64::from(protect_minutes)
}

fn parse_cursor(cursor: Option<&str>) -> usize {
    cursor
        .and_then(|c| {
            let t = c.trim();
            if t.is_empty() {
                None
            } else {
                t.parse::<usize>().ok()
            }
        })
        .unwrap_or(0)
}

fn encode_cursor(offset: usize) -> String {
    offset.to_string()
}

fn empty_page(now: DateTime<Utc>) -> FeedPage {
    FeedPage {
        post_uuids: Vec::new(),
        next_cursor: None,
        has_more: false,
        generated_at: now,
        expires_at: now,
    }
}

fn page_from_list(
    ordered: Vec<Uuid>,
    take: i32,
    cursor: Option<&str>,
    generated_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
) -> FeedPage {
    let offset = parse_cursor(cursor);
    let page: Vec<Uuid> = ordered
        .iter()
        .skip(offset)
        .take(take as usize)
        .copied()
        .collect();
    let next = if offset + page.len() < ordered.len() {
        Some(encode_cursor(offset + take as usize))
    } else {
        None
    };
    FeedPage {
        post_uuids: page,
        next_cursor: next.clone(),
        has_more: next.is_some(),
        generated_at,
        expires_at,
    }
}

fn random_f64() -> f64 {
    let mut buf = [0u8; 8];
    let _ = getrandom::fill(&mut buf);
    f64::from_bits(u64::from_le_bytes(buf) >> 11) / ((1u64 << 53) as f64)
}
