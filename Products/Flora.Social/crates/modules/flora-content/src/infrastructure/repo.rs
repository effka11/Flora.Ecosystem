//! Кандидатные SQL-запросы FIRA-F / подписки — порт `ContentFeedQueries.cs`.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct FeedPostLite {
    pub post_uuid: Uuid,
    pub author_user_uuid: Uuid,
    pub created_at: DateTime<Utc>,
    pub content: String,
    pub community_id: Option<Uuid>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PostRow {
    pub post_uuid: Uuid,
    pub content: String,
    pub created_at: DateTime<Utc>,
    pub author_user_uuid: Uuid,
    pub community_id: Option<Uuid>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ProfilePostRow {
    pub post_uuid: Uuid,
    pub content: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct CommunityLite {
    pub community_id: Uuid,
    pub name: String,
    pub slug: String,
    pub avatar_uuid: Option<Uuid>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct CommunityRow {
    pub community_id: Uuid,
    pub name: String,
    pub slug: String,
    pub avatar_uuid: Option<Uuid>,
    pub is_private: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct CommunityNameSlug {
    pub name: String,
    pub slug: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MembershipRow {
    pub role: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct CommunityMeta {
    pub is_private: bool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RecommendationCandidateRow {
    pub community_id: Uuid,
    pub name: String,
    pub slug: String,
    pub avatar_uuid: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub member_count: i32,
    pub recent_post_count: i32,
    pub followed_members_count: i32,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct VideoLite {
    pub post_uuid: Uuid,
    pub video_uuid: Uuid,
    pub status: i32,
    pub width: i32,
    pub height: i32,
    pub duration_ms: i32,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PostDraftRow {
    pub draft_uuid: Uuid,
    pub label: String,
    pub content: String,
    pub community_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PostDraftAuthRow {
    pub draft_uuid: Uuid,
    pub author_user_uuid: Uuid,
    pub label: String,
    pub content: String,
    pub community_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct CommentRow {
    pub comment_uuid: Uuid,
    pub parent_comment_uuid: Option<Uuid>,
    pub author_user_uuid: Uuid,
    pub content: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct CommentDeleteRow {
    pub author_user_uuid: Uuid,
    pub is_deleted: bool,
}

#[derive(Debug, Clone)]
pub struct MediaBlob {
    pub data: Vec<u8>,
    pub content_type: String,
}

#[derive(Debug, Clone)]
pub struct PostMediaBlob {
    pub post_uuid: Uuid,
    pub blob: MediaBlob,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct MediaRow {
    data: Vec<u8>,
    content_type: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct PostImageRow {
    post_uuid: Uuid,
    data: Vec<u8>,
    content_type: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct PosterRow {
    post_uuid: Uuid,
    poster_data: Vec<u8>,
    poster_content_type: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct VideoRow {
    post_uuid: Uuid,
    data: Vec<u8>,
    content_type: String,
    status: i32,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct CountRow {
    post_uuid: Uuid,
    count: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct TrendingWindowRow {
    post_uuid: Uuid,
    created_at: DateTime<Utc>,
}

pub struct ContentRepo {
    pool: PgPool,
}

impl ContentRepo {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn posts_by_authors_since(
        &self,
        author_ids: &[Uuid],
        since: DateTime<Utc>,
        take: i64,
        viewer_user_uuid: Uuid,
    ) -> Result<Vec<FeedPostLite>, sqlx::Error> {
        if author_ids.is_empty() {
            return Ok(Vec::new());
        }
        sqlx::query_as(
            r#"
            SELECT p.post_uuid, p.author_user_uuid, p.created_at, p.content, p.community_id
            FROM flora_core.user_posts p
            WHERE p.is_deleted = false
              AND p.created_at >= $1
              AND p.author_user_uuid = ANY($2)
              AND (
                  p.community_id IS NULL
                  OR NOT EXISTS (
                      SELECT 1 FROM flora_core.communities c
                      WHERE c.community_id = p.community_id AND c.is_private = true
                  )
                  OR EXISTS (
                      SELECT 1 FROM flora_core.user_communities uc
                      WHERE uc.community_id = p.community_id AND uc.user_uuid = $4
                  )
              )
            ORDER BY p.created_at DESC
            LIMIT $3
            "#,
        )
        .bind(since)
        .bind(author_ids)
        .bind(take)
        .bind(viewer_user_uuid)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn posts_by_ids(
        &self,
        post_ids: &[Uuid],
        viewer_user_uuid: Uuid,
    ) -> Result<Vec<FeedPostLite>, sqlx::Error> {
        if post_ids.is_empty() {
            return Ok(Vec::new());
        }
        sqlx::query_as(
            r#"
            SELECT p.post_uuid, p.author_user_uuid, p.created_at, p.content, p.community_id
            FROM flora_core.user_posts p
            WHERE p.is_deleted = false
              AND p.post_uuid = ANY($1)
              AND (
                  p.community_id IS NULL
                  OR NOT EXISTS (
                      SELECT 1 FROM flora_core.communities c
                      WHERE c.community_id = p.community_id AND c.is_private = true
                  )
                  OR EXISTS (
                      SELECT 1 FROM flora_core.user_communities uc
                      WHERE uc.community_id = p.community_id AND uc.user_uuid = $2
                  )
              )
            "#,
        )
        .bind(post_ids)
        .bind(viewer_user_uuid)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn first_reposts_from_users(
        &self,
        user_ids: &[Uuid],
        since: DateTime<Utc>,
        limit: i64,
    ) -> Result<Vec<(Uuid, DateTime<Utc>)>, sqlx::Error> {
        if user_ids.is_empty() {
            return Ok(Vec::new());
        }
        sqlx::query_as(
            r#"
            SELECT r.post_uuid, MIN(r.created_at) AS first_repost_at
            FROM flora_core.post_reposts r
            WHERE r.user_uuid = ANY($1)
              AND r.created_at >= $2
            GROUP BY r.post_uuid
            ORDER BY first_repost_at DESC
            LIMIT $3
            "#,
        )
        .bind(user_ids)
        .bind(since)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn has_newer_posts(
        &self,
        followed_user_ids: &[Uuid],
        visible_personal_author_ids: &[Uuid],
        since: DateTime<Utc>,
        viewer_user_uuid: Uuid,
    ) -> Result<bool, sqlx::Error> {
        if followed_user_ids.is_empty() {
            return Ok(false);
        }
        sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM flora_core.user_posts p
                WHERE p.is_deleted = false
                  AND p.created_at > $1
                  AND p.author_user_uuid = ANY($2)
                  AND (
                      (
                          p.community_id IS NULL
                          AND p.author_user_uuid = ANY($4)
                      )
                      OR (
                          p.community_id IS NOT NULL
                          AND (
                              EXISTS (
                                  SELECT 1 FROM flora_core.communities c
                                  WHERE c.community_id = p.community_id AND c.is_private = false
                              )
                              OR EXISTS (
                                  SELECT 1 FROM flora_core.user_communities uc
                                  WHERE uc.community_id = p.community_id AND uc.user_uuid = $3
                              )
                          )
                      )
                  )
            )
            "#,
        )
        .bind(since)
        .bind(followed_user_ids)
        .bind(viewer_user_uuid)
        .bind(visible_personal_author_ids)
        .fetch_one(&self.pool)
        .await
    }

    pub async fn own_post_ids(&self, user_uuid: Uuid, take: i32) -> Result<Vec<Uuid>, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT post_uuid
            FROM flora_core.user_posts
            WHERE author_user_uuid = $1
              AND is_deleted = false
            ORDER BY created_at DESC
            LIMIT $2
            "#,
        )
        .bind(user_uuid)
        .bind(i64::from(take))
        .fetch_all(&self.pool)
        .await
    }

    pub async fn latest_posts(
        &self,
        take: i64,
        viewer_user_uuid: Uuid,
    ) -> Result<Vec<FeedPostLite>, sqlx::Error> {
        sqlx::query_as(
            r#"
            SELECT p.post_uuid, p.author_user_uuid, p.created_at, p.content, p.community_id
            FROM flora_core.user_posts p
            WHERE p.is_deleted = false
              AND (
                  p.community_id IS NULL
                  OR NOT EXISTS (
                      SELECT 1 FROM flora_core.communities c
                      WHERE c.community_id = p.community_id AND c.is_private = true
                  )
                  OR EXISTS (
                      SELECT 1 FROM flora_core.user_communities uc
                      WHERE uc.community_id = p.community_id AND uc.user_uuid = $1
                  )
              )
            ORDER BY p.created_at DESC, p.post_uuid ASC
            LIMIT $2
            "#,
        )
        .bind(viewer_user_uuid)
        .bind(take)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn exploration_posts(
        &self,
        since: DateTime<Utc>,
        exclude_post_ids: &[Uuid],
        limit: i64,
        viewer_user_uuid: Uuid,
    ) -> Result<Vec<FeedPostLite>, sqlx::Error> {
        let epoch = DateTime::<Utc>::UNIX_EPOCH;
        sqlx::query_as(
            r#"
            SELECT p.post_uuid, p.author_user_uuid, p.created_at, p.content, p.community_id
            FROM flora_core.user_posts p
            WHERE p.is_deleted = false
              AND ($1 = $2 OR p.created_at >= $1)
              AND NOT (p.post_uuid = ANY($3))
              AND (
                  p.community_id IS NULL
                  OR NOT EXISTS (
                      SELECT 1 FROM flora_core.communities c
                      WHERE c.community_id = p.community_id AND c.is_private = true
                  )
                  OR EXISTS (
                      SELECT 1 FROM flora_core.user_communities uc
                      WHERE uc.community_id = p.community_id AND uc.user_uuid = $4
                  )
              )
            ORDER BY random()
            LIMIT $5
            "#,
        )
        .bind(since)
        .bind(epoch)
        .bind(exclude_post_ids)
        .bind(viewer_user_uuid)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn community_posts_for_user(
        &self,
        user_uuid: Uuid,
        since: DateTime<Utc>,
        take: i64,
    ) -> Result<Vec<FeedPostLite>, sqlx::Error> {
        sqlx::query_as(
            r#"
            SELECT p.post_uuid, p.author_user_uuid, p.created_at, p.content, p.community_id
            FROM flora_core.user_posts p
            WHERE p.is_deleted = false
              AND p.community_id IS NOT NULL
              AND p.created_at >= $1
              AND EXISTS (
                  SELECT 1 FROM flora_core.user_communities uc
                  WHERE uc.community_id = p.community_id AND uc.user_uuid = $2
              )
            ORDER BY p.created_at DESC
            LIMIT $3
            "#,
        )
        .bind(since)
        .bind(user_uuid)
        .bind(take)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn trending_post_ids(
        &self,
        since: DateTime<Utc>,
        limit: i64,
        exclude_authors: &[Uuid],
        viewer_user_uuid: Uuid,
    ) -> Result<Vec<Uuid>, sqlx::Error> {
        if limit <= 0 {
            return Ok(Vec::new());
        }
        let window: Vec<TrendingWindowRow> = sqlx::query_as(
            r#"
            SELECT p.post_uuid, p.created_at
            FROM flora_core.user_posts p
            WHERE p.is_deleted = false
              AND p.created_at >= $1
              AND NOT (p.author_user_uuid = ANY($2))
              AND (
                  p.community_id IS NULL
                  OR NOT EXISTS (
                      SELECT 1 FROM flora_core.communities c
                      WHERE c.community_id = p.community_id AND c.is_private = true
                  )
                  OR EXISTS (
                      SELECT 1 FROM flora_core.user_communities uc
                      WHERE uc.community_id = p.community_id AND uc.user_uuid = $3
                  )
              )
            ORDER BY p.created_at DESC, p.post_uuid ASC
            LIMIT $4
            "#,
        )
        .bind(since)
        .bind(exclude_authors)
        .bind(viewer_user_uuid)
        .bind(limit.saturating_mul(3))
        .fetch_all(&self.pool)
        .await?;

        if window.is_empty() {
            return Ok(Vec::new());
        }

        let post_ids: Vec<Uuid> = window.iter().map(|w| w.post_uuid).collect();
        let likes = self
            .count_engagement("post_likes", &post_ids, false)
            .await?;
        let comments = self
            .count_engagement("post_comments", &post_ids, true)
            .await?;
        let reposts = self
            .count_engagement("post_reposts", &post_ids, false)
            .await?;

        let mut scored: Vec<(Uuid, DateTime<Utc>, f64)> = window
            .into_iter()
            .map(|w| {
                let l = likes.get(&w.post_uuid).copied().unwrap_or(0) as f64;
                let c = comments.get(&w.post_uuid).copied().unwrap_or(0) as f64;
                let r = reposts.get(&w.post_uuid).copied().unwrap_or(0) as f64;
                (w.post_uuid, w.created_at, l + c * 2.0 + r * 2.5)
            })
            .collect();

        scored.sort_by(|a, b| {
            b.2.partial_cmp(&a.2)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.1.cmp(&a.1))
                .then_with(|| a.0.cmp(&b.0))
        });

        Ok(scored
            .into_iter()
            .take(limit as usize)
            .map(|(id, _, _)| id)
            .collect())
    }

    pub async fn engagement_48h(
        &self,
        post_ids: &[Uuid],
    ) -> Result<HashMap<Uuid, (i32, i32, i32, i32)>, sqlx::Error> {
        if post_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let cutoff = Utc::now() - chrono::Duration::hours(48);
        let likes = self
            .count_since("post_likes", "created_at", post_ids, cutoff, false)
            .await?;
        let comments = self
            .count_since("post_comments", "created_at", post_ids, cutoff, true)
            .await?;
        let reposts = self
            .count_since("post_reposts", "created_at", post_ids, cutoff, false)
            .await?;
        let views = self
            .count_since("post_views", "viewed_at", post_ids, cutoff, false)
            .await?;

        Ok(post_ids
            .iter()
            .map(|pid| {
                (
                    *pid,
                    (
                        likes.get(pid).copied().unwrap_or(0),
                        comments.get(pid).copied().unwrap_or(0),
                        reposts.get(pid).copied().unwrap_or(0),
                        views.get(pid).copied().unwrap_or(0),
                    ),
                )
            })
            .collect())
    }

    pub async fn followed_liker_counts(
        &self,
        post_ids: &[Uuid],
        followed_user_ids: &[Uuid],
    ) -> Result<HashMap<Uuid, i32>, sqlx::Error> {
        if post_ids.is_empty() || followed_user_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows: Vec<CountRow> = sqlx::query_as(
            r#"
            SELECT post_uuid, COUNT(*)::bigint AS count
            FROM flora_core.post_likes
            WHERE post_uuid = ANY($1)
              AND user_uuid = ANY($2)
            GROUP BY post_uuid
            "#,
        )
        .bind(post_ids)
        .bind(followed_user_ids)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| (r.post_uuid, r.count as i32))
            .collect())
    }

    pub async fn author_interaction_scores(
        &self,
        user_uuid: Uuid,
        author_ids: &[Uuid],
        since: DateTime<Utc>,
    ) -> Result<HashMap<Uuid, f64>, sqlx::Error> {
        if author_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let liked: Vec<(Uuid, i64)> = sqlx::query_as(
            r#"
            SELECT p.author_user_uuid, COUNT(*)::bigint
            FROM flora_core.post_likes l
            INNER JOIN flora_core.user_posts p ON p.post_uuid = l.post_uuid
            WHERE l.user_uuid = $1
              AND p.author_user_uuid = ANY($2)
              AND l.created_at >= $3
            GROUP BY p.author_user_uuid
            "#,
        )
        .bind(user_uuid)
        .bind(author_ids)
        .bind(since)
        .fetch_all(&self.pool)
        .await?;

        let commented: Vec<(Uuid, i64)> = sqlx::query_as(
            r#"
            SELECT p.author_user_uuid, COUNT(*)::bigint
            FROM flora_core.post_comments c
            INNER JOIN flora_core.user_posts p ON p.post_uuid = c.post_uuid
            WHERE c.author_user_uuid = $1
              AND p.author_user_uuid = ANY($2)
              AND c.created_at >= $3
            GROUP BY p.author_user_uuid
            "#,
        )
        .bind(user_uuid)
        .bind(author_ids)
        .bind(since)
        .fetch_all(&self.pool)
        .await?;

        let reposted: Vec<(Uuid, i64)> = sqlx::query_as(
            r#"
            SELECT p.author_user_uuid, COUNT(*)::bigint
            FROM flora_core.post_reposts r
            INNER JOIN flora_core.user_posts p ON p.post_uuid = r.post_uuid
            WHERE r.user_uuid = $1
              AND p.author_user_uuid = ANY($2)
              AND r.created_at >= $3
            GROUP BY p.author_user_uuid
            "#,
        )
        .bind(user_uuid)
        .bind(author_ids)
        .bind(since)
        .fetch_all(&self.pool)
        .await?;

        let mut result: HashMap<Uuid, f64> = HashMap::new();
        for (author, cnt) in liked {
            *result.entry(author).or_insert(0.0) += cnt as f64;
        }
        for (author, cnt) in commented {
            *result.entry(author).or_insert(0.0) += cnt as f64 * 2.0;
        }
        for (author, cnt) in reposted {
            *result.entry(author).or_insert(0.0) += cnt as f64 * 2.5;
        }
        Ok(result)
    }

    pub async fn reposts_from_users(
        &self,
        user_ids: &[Uuid],
        since: DateTime<Utc>,
        limit: i64,
    ) -> Result<Vec<(Uuid, Uuid)>, sqlx::Error> {
        if user_ids.is_empty() {
            return Ok(Vec::new());
        }
        sqlx::query_as(
            r#"
            SELECT post_uuid, user_uuid
            FROM flora_core.post_reposts
            WHERE user_uuid = ANY($1)
              AND created_at >= $2
            ORDER BY created_at DESC
            LIMIT $3
            "#,
        )
        .bind(user_ids)
        .bind(since)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn followed_reposter_ids_by_posts(
        &self,
        post_ids: &[Uuid],
        followed_user_ids: &[Uuid],
    ) -> Result<HashMap<Uuid, Vec<Uuid>>, sqlx::Error> {
        if post_ids.is_empty() || followed_user_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows: Vec<(Uuid, Uuid)> = sqlx::query_as(
            r#"
            SELECT post_uuid, user_uuid
            FROM flora_core.post_reposts
            WHERE post_uuid = ANY($1)
              AND user_uuid = ANY($2)
            ORDER BY created_at DESC
            "#,
        )
        .bind(post_ids)
        .bind(followed_user_ids)
        .fetch_all(&self.pool)
        .await?;

        let mut result: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
        for (post_uuid, user_uuid) in rows {
            let list = result.entry(post_uuid).or_default();
            if !list.contains(&user_uuid) {
                list.push(user_uuid);
            }
        }
        Ok(result)
    }

    pub async fn load_posts_ordered(
        &self,
        post_uuids: &[Uuid],
    ) -> Result<Vec<PostRow>, sqlx::Error> {
        if post_uuids.is_empty() {
            return Ok(Vec::new());
        }
        let mut rows: Vec<PostRow> = sqlx::query_as(
            r#"
            SELECT post_uuid, content, created_at, author_user_uuid, community_id
            FROM flora_core.user_posts
            WHERE post_uuid = ANY($1)
              AND is_deleted = false
            "#,
        )
        .bind(post_uuids)
        .fetch_all(&self.pool)
        .await?;

        let order: HashMap<Uuid, usize> = post_uuids
            .iter()
            .enumerate()
            .map(|(i, id)| (*id, i))
            .collect();
        rows.sort_by_key(|p| order.get(&p.post_uuid).copied().unwrap_or(usize::MAX));
        Ok(rows)
    }

    pub async fn profile_posts_by_author(
        &self,
        author_uuid: Uuid,
        skip: i64,
        take: i64,
    ) -> Result<Vec<ProfilePostRow>, sqlx::Error> {
        sqlx::query_as(
            r#"
            SELECT post_uuid, content, created_at
            FROM flora_core.user_posts
            WHERE author_user_uuid = $1
              AND is_deleted = false
              AND community_id IS NULL
            ORDER BY created_at DESC
            OFFSET $2 LIMIT $3
            "#,
        )
        .bind(author_uuid)
        .bind(skip)
        .bind(take)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn profile_liked_posts(
        &self,
        user_uuid: Uuid,
        skip: i64,
        take: i64,
    ) -> Result<Vec<ProfilePostRow>, sqlx::Error> {
        sqlx::query_as(
            r#"
            SELECT p.post_uuid, p.content, p.created_at
            FROM flora_core.post_likes l
            INNER JOIN flora_core.user_posts p ON l.post_uuid = p.post_uuid
            WHERE l.user_uuid = $1
              AND p.is_deleted = false
              AND p.community_id IS NULL
            ORDER BY l.created_at DESC
            OFFSET $2 LIMIT $3
            "#,
        )
        .bind(user_uuid)
        .bind(skip)
        .bind(take)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn profile_reposted_posts(
        &self,
        user_uuid: Uuid,
        skip: i64,
        take: i64,
    ) -> Result<Vec<ProfilePostRow>, sqlx::Error> {
        sqlx::query_as(
            r#"
            SELECT p.post_uuid, p.content, p.created_at
            FROM flora_core.post_reposts r
            INNER JOIN flora_core.user_posts p ON r.post_uuid = p.post_uuid
            WHERE r.user_uuid = $1
              AND p.is_deleted = false
              AND p.community_id IS NULL
            ORDER BY r.created_at DESC
            OFFSET $2 LIMIT $3
            "#,
        )
        .bind(user_uuid)
        .bind(skip)
        .bind(take)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn communities_by_ids(
        &self,
        community_ids: &[Uuid],
    ) -> Result<Vec<CommunityLite>, sqlx::Error> {
        if community_ids.is_empty() {
            return Ok(Vec::new());
        }
        sqlx::query_as(
            r#"
            SELECT community_id, name, slug, avatar_uuid
            FROM flora_core.communities
            WHERE community_id = ANY($1)
            "#,
        )
        .bind(community_ids)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn accessible_community_ids(
        &self,
        community_ids: &[Uuid],
        viewer_user_uuid: Option<Uuid>,
    ) -> Result<Vec<Uuid>, sqlx::Error> {
        if community_ids.is_empty() {
            return Ok(Vec::new());
        }
        sqlx::query_scalar(
            r#"
            SELECT community_id
            FROM flora_core.communities communities
            WHERE community_id = ANY($1)
              AND (
                    communities.is_private = false
                    OR (
                      $2::uuid IS NOT NULL
                      AND EXISTS (
                        SELECT 1
                        FROM flora_core.user_communities memberships
                        WHERE memberships.community_id = communities.community_id
                          AND memberships.user_uuid = $2
                      )
                    )
                  )
            "#,
        )
        .bind(community_ids)
        .bind(viewer_user_uuid)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn count_by_post(
        &self,
        table: &str,
        post_ids: &[Uuid],
        exclude_deleted_comments: bool,
    ) -> Result<HashMap<Uuid, i32>, sqlx::Error> {
        if post_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows = match table {
            "post_comments" if exclude_deleted_comments => {
                sqlx::query_as::<_, CountRow>(
                    r#"
                    SELECT post_uuid, COUNT(*)::bigint AS count
                    FROM flora_core.post_comments
                    WHERE post_uuid = ANY($1)
                      AND is_deleted = false
                    GROUP BY post_uuid
                    "#,
                )
                .bind(post_ids)
                .fetch_all(&self.pool)
                .await?
            }
            "post_comments" => {
                sqlx::query_as::<_, CountRow>(
                    r#"
                    SELECT post_uuid, COUNT(*)::bigint AS count
                    FROM flora_core.post_comments
                    WHERE post_uuid = ANY($1)
                    GROUP BY post_uuid
                    "#,
                )
                .bind(post_ids)
                .fetch_all(&self.pool)
                .await?
            }
            "post_likes" => {
                sqlx::query_as::<_, CountRow>(
                    r#"
                    SELECT post_uuid, COUNT(*)::bigint AS count
                    FROM flora_core.post_likes
                    WHERE post_uuid = ANY($1)
                    GROUP BY post_uuid
                    "#,
                )
                .bind(post_ids)
                .fetch_all(&self.pool)
                .await?
            }
            "post_reposts" => {
                sqlx::query_as::<_, CountRow>(
                    r#"
                    SELECT post_uuid, COUNT(*)::bigint AS count
                    FROM flora_core.post_reposts
                    WHERE post_uuid = ANY($1)
                    GROUP BY post_uuid
                    "#,
                )
                .bind(post_ids)
                .fetch_all(&self.pool)
                .await?
            }
            "post_views" => {
                sqlx::query_as::<_, CountRow>(
                    r#"
                    SELECT post_uuid, COUNT(*)::bigint AS count
                    FROM flora_core.post_views
                    WHERE post_uuid = ANY($1)
                    GROUP BY post_uuid
                    "#,
                )
                .bind(post_ids)
                .fetch_all(&self.pool)
                .await?
            }
            _ => Vec::new(),
        };
        Ok(rows
            .into_iter()
            .map(|r| (r.post_uuid, r.count as i32))
            .collect())
    }

    pub async fn viewer_flags(
        &self,
        viewer: Uuid,
        post_uuids: &[Uuid],
    ) -> Result<(HashSet<Uuid>, HashSet<Uuid>, HashSet<Uuid>), sqlx::Error> {
        if post_uuids.is_empty() {
            return Ok((HashSet::new(), HashSet::new(), HashSet::new()));
        }

        let liked: Vec<Uuid> = sqlx::query_scalar(
            r#"
            SELECT post_uuid
            FROM flora_core.post_likes
            WHERE user_uuid = $1
              AND post_uuid = ANY($2)
            "#,
        )
        .bind(viewer)
        .bind(post_uuids)
        .fetch_all(&self.pool)
        .await?;

        let reposted: Vec<Uuid> = sqlx::query_scalar(
            r#"
            SELECT post_uuid
            FROM flora_core.post_reposts
            WHERE user_uuid = $1
              AND post_uuid = ANY($2)
            "#,
        )
        .bind(viewer)
        .bind(post_uuids)
        .fetch_all(&self.pool)
        .await?;

        let commented: Vec<Uuid> = sqlx::query_scalar(
            r#"
            SELECT DISTINCT post_uuid
            FROM flora_core.post_comments
            WHERE author_user_uuid = $1
              AND post_uuid = ANY($2)
              AND is_deleted = false
            "#,
        )
        .bind(viewer)
        .bind(post_uuids)
        .fetch_all(&self.pool)
        .await?;

        Ok((
            liked.into_iter().collect(),
            reposted.into_iter().collect(),
            commented.into_iter().collect(),
        ))
    }

    pub async fn image_uuids_by_posts(
        &self,
        post_uuids: &[Uuid],
    ) -> Result<HashMap<Uuid, Vec<Uuid>>, sqlx::Error> {
        if post_uuids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows: Vec<(Uuid, Uuid)> = sqlx::query_as(
            r#"
            SELECT post_uuid, uuid
            FROM flora_core.post_images
            WHERE post_uuid = ANY($1)
            ORDER BY post_uuid, sort_order
            "#,
        )
        .bind(post_uuids)
        .fetch_all(&self.pool)
        .await?;

        let mut out: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
        for (post_uuid, image_uuid) in rows {
            out.entry(post_uuid).or_default().push(image_uuid);
        }
        Ok(out)
    }

    pub async fn videos_by_posts(
        &self,
        post_uuids: &[Uuid],
    ) -> Result<HashMap<Uuid, VideoLite>, sqlx::Error> {
        if post_uuids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows: Vec<VideoLite> = sqlx::query_as(
            r#"
            SELECT post_uuid, uuid AS video_uuid, status, width, height, duration_ms
            FROM flora_core.post_videos
            WHERE post_uuid = ANY($1)
            "#,
        )
        .bind(post_uuids)
        .fetch_all(&self.pool)
        .await?;

        let mut out: HashMap<Uuid, VideoLite> = HashMap::new();
        for row in rows {
            out.entry(row.post_uuid).or_insert(row);
        }
        Ok(out)
    }

    pub async fn is_community_owner(
        &self,
        community_id: Uuid,
        user_uuid: Uuid,
    ) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM flora_core.user_communities
                WHERE community_id = $1
                  AND user_uuid = $2
                  AND role = 'Owner'
            )
            "#,
        )
        .bind(community_id)
        .bind(user_uuid)
        .fetch_one(&self.pool)
        .await
    }

    pub async fn insert_post(
        &self,
        post_uuid: Uuid,
        author: Uuid,
        content: &str,
        community_id: Option<Uuid>,
        created_at: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.user_posts
                (post_uuid, author_user_uuid, community_id, content, created_at, is_deleted)
            VALUES ($1, $2, $3, $4, $5, false)
            "#,
        )
        .bind(post_uuid)
        .bind(author)
        .bind(community_id)
        .bind(content)
        .bind(created_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn post_exists(&self, post_uuid: Uuid) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM flora_core.user_posts
                WHERE post_uuid = $1
                  AND is_deleted = false
            )
            "#,
        )
        .bind(post_uuid)
        .fetch_one(&self.pool)
        .await
    }

    pub async fn post_for_delete(
        &self,
        post_uuid: Uuid,
    ) -> Result<Option<(Uuid, bool)>, sqlx::Error> {
        sqlx::query_as(
            r#"
            SELECT author_user_uuid, is_deleted
            FROM flora_core.user_posts
            WHERE post_uuid = $1
            "#,
        )
        .bind(post_uuid)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn soft_delete_post(
        &self,
        post_uuid: Uuid,
        deleted_at: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE flora_core.user_posts
            SET is_deleted = true, deleted_at = $2
            WHERE post_uuid = $1
            "#,
        )
        .bind(post_uuid)
        .bind(deleted_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn post_community_id(
        &self,
        post_uuid: Uuid,
    ) -> Result<Option<Option<Uuid>>, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT community_id
            FROM flora_core.user_posts
            WHERE post_uuid = $1
              AND is_deleted = false
            "#,
        )
        .bind(post_uuid)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn is_community_private(&self, community_id: Uuid) -> Result<bool, sqlx::Error> {
        let is_private: Option<bool> = sqlx::query_scalar(
            r#"
            SELECT is_private
            FROM flora_core.communities
            WHERE community_id = $1
            "#,
        )
        .bind(community_id)
        .fetch_optional(&self.pool)
        .await?;
        // Missing community metadata must not turn an orphaned post public.
        Ok(is_private.unwrap_or(true))
    }

    pub async fn is_community_member(
        &self,
        community_id: Uuid,
        user_uuid: Uuid,
    ) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM flora_core.user_communities
                WHERE community_id = $1
                  AND user_uuid = $2
            )
            "#,
        )
        .bind(community_id)
        .bind(user_uuid)
        .fetch_one(&self.pool)
        .await
    }

    pub async fn has_liked(&self, post_uuid: Uuid, user_uuid: Uuid) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM flora_core.post_likes
                WHERE post_uuid = $1
                  AND user_uuid = $2
            )
            "#,
        )
        .bind(post_uuid)
        .bind(user_uuid)
        .fetch_one(&self.pool)
        .await
    }

    pub async fn insert_like(
        &self,
        post_uuid: Uuid,
        user_uuid: Uuid,
        created_at: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.post_likes (post_uuid, user_uuid, created_at)
            VALUES ($1, $2, $3)
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(post_uuid)
        .bind(user_uuid)
        .bind(created_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_like(&self, post_uuid: Uuid, user_uuid: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            DELETE FROM flora_core.post_likes
            WHERE post_uuid = $1
              AND user_uuid = $2
            "#,
        )
        .bind(post_uuid)
        .bind(user_uuid)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn like_count(&self, post_uuid: Uuid) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM flora_core.post_likes
            WHERE post_uuid = $1
            "#,
        )
        .bind(post_uuid)
        .fetch_one(&self.pool)
        .await
    }

    pub async fn has_reposted(
        &self,
        post_uuid: Uuid,
        user_uuid: Uuid,
    ) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM flora_core.post_reposts
                WHERE post_uuid = $1
                  AND user_uuid = $2
            )
            "#,
        )
        .bind(post_uuid)
        .bind(user_uuid)
        .fetch_one(&self.pool)
        .await
    }

    pub async fn insert_repost(
        &self,
        post_uuid: Uuid,
        user_uuid: Uuid,
        created_at: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.post_reposts (post_uuid, user_uuid, created_at)
            VALUES ($1, $2, $3)
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(post_uuid)
        .bind(user_uuid)
        .bind(created_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_repost(&self, post_uuid: Uuid, user_uuid: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            DELETE FROM flora_core.post_reposts
            WHERE post_uuid = $1
              AND user_uuid = $2
            "#,
        )
        .bind(post_uuid)
        .bind(user_uuid)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn repost_count(&self, post_uuid: Uuid) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM flora_core.post_reposts
            WHERE post_uuid = $1
            "#,
        )
        .bind(post_uuid)
        .fetch_one(&self.pool)
        .await
    }

    pub async fn has_viewed(&self, post_uuid: Uuid, user_uuid: Uuid) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM flora_core.post_views
                WHERE post_uuid = $1
                  AND user_uuid = $2
            )
            "#,
        )
        .bind(post_uuid)
        .bind(user_uuid)
        .fetch_one(&self.pool)
        .await
    }

    pub async fn insert_view(
        &self,
        post_uuid: Uuid,
        user_uuid: Uuid,
        viewed_at: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.post_views (post_uuid, user_uuid, viewed_at)
            VALUES ($1, $2, $3)
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(post_uuid)
        .bind(user_uuid)
        .bind(viewed_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn view_count(&self, post_uuid: Uuid) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM flora_core.post_views
            WHERE post_uuid = $1
            "#,
        )
        .bind(post_uuid)
        .fetch_one(&self.pool)
        .await
    }

    pub async fn comments_by_post(&self, post_uuid: Uuid) -> Result<Vec<CommentRow>, sqlx::Error> {
        sqlx::query_as(
            r#"
            SELECT comment_uuid, parent_comment_uuid, author_user_uuid, content, created_at
            FROM flora_core.post_comments
            WHERE post_uuid = $1
              AND is_deleted = false
            ORDER BY created_at ASC
            "#,
        )
        .bind(post_uuid)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn comment_exists(
        &self,
        post_uuid: Uuid,
        comment_uuid: Uuid,
    ) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM flora_core.post_comments
                WHERE post_uuid = $1
                  AND comment_uuid = $2
                  AND is_deleted = false
            )
            "#,
        )
        .bind(post_uuid)
        .bind(comment_uuid)
        .fetch_one(&self.pool)
        .await
    }

    pub async fn post_author_uuid(&self, post_uuid: Uuid) -> Result<Option<Uuid>, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT author_user_uuid
            FROM flora_core.user_posts
            WHERE post_uuid = $1
              AND is_deleted = false
            "#,
        )
        .bind(post_uuid)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn comment_parent_uuid(
        &self,
        post_uuid: Uuid,
        comment_uuid: Uuid,
    ) -> Result<Option<Option<Uuid>>, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT parent_comment_uuid
            FROM flora_core.post_comments
            WHERE post_uuid = $1
              AND comment_uuid = $2
              AND is_deleted = false
            "#,
        )
        .bind(post_uuid)
        .bind(comment_uuid)
        .fetch_optional(&self.pool)
        .await
    }

    /// Author of a non-deleted comment (for reply notifications).
    pub async fn comment_author_uuid(
        &self,
        comment_uuid: Uuid,
    ) -> Result<Option<Uuid>, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT author_user_uuid
            FROM flora_core.post_comments
            WHERE comment_uuid = $1
              AND is_deleted = false
            "#,
        )
        .bind(comment_uuid)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn insert_comment(
        &self,
        comment_uuid: Uuid,
        post_uuid: Uuid,
        author_user_uuid: Uuid,
        content: &str,
        parent_comment_uuid: Option<Uuid>,
        created_at: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.post_comments
                (comment_uuid, post_uuid, author_user_uuid, content, parent_comment_uuid, created_at, is_deleted)
            VALUES ($1, $2, $3, $4, $5, $6, false)
            "#,
        )
        .bind(comment_uuid)
        .bind(post_uuid)
        .bind(author_user_uuid)
        .bind(content)
        .bind(parent_comment_uuid)
        .bind(created_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn comment_for_delete(
        &self,
        post_uuid: Uuid,
        comment_uuid: Uuid,
    ) -> Result<Option<CommentDeleteRow>, sqlx::Error> {
        sqlx::query_as(
            r#"
            SELECT author_user_uuid, is_deleted
            FROM flora_core.post_comments
            WHERE post_uuid = $1
              AND comment_uuid = $2
            "#,
        )
        .bind(post_uuid)
        .bind(comment_uuid)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn soft_delete_comment(
        &self,
        comment_uuid: Uuid,
        deleted_at: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE flora_core.post_comments
            SET is_deleted = true, deleted_at = $2
            WHERE comment_uuid = $1
            "#,
        )
        .bind(comment_uuid)
        .bind(deleted_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn post_image_by_uuid(
        &self,
        uuid: Uuid,
    ) -> Result<Option<PostMediaBlob>, sqlx::Error> {
        let row: Option<PostImageRow> = sqlx::query_as(
            r#"
            SELECT post_uuid, data, content_type
            FROM flora_core.post_images
            WHERE uuid = $1
            "#,
        )
        .bind(uuid)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.filter(|r| !r.data.is_empty()).map(|r| PostMediaBlob {
            post_uuid: r.post_uuid,
            blob: MediaBlob {
                data: r.data,
                content_type: r.content_type,
            },
        }))
    }

    pub async fn count_post_images(&self, post_uuid: Uuid) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM flora_core.post_images
            WHERE post_uuid = $1
            "#,
        )
        .bind(post_uuid)
        .fetch_one(&self.pool)
        .await
    }

    pub async fn insert_post_image(
        &self,
        uuid: Uuid,
        post_uuid: Uuid,
        content_type: &str,
        data: &[u8],
        sort_order: i32,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.post_images (uuid, post_uuid, content_type, data, sort_order)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(uuid)
        .bind(post_uuid)
        .bind(content_type)
        .bind(data)
        .bind(sort_order)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_post_drafts(
        &self,
        author: Uuid,
        community_id: Option<Uuid>,
    ) -> Result<Vec<PostDraftRow>, sqlx::Error> {
        if let Some(cid) = community_id {
            sqlx::query_as(
                r#"
                SELECT draft_uuid, label, content, community_id, created_at, updated_at
                FROM flora_core.post_drafts
                WHERE author_user_uuid = $1
                  AND community_id = $2
                ORDER BY updated_at DESC, created_at DESC
                "#,
            )
            .bind(author)
            .bind(cid)
            .fetch_all(&self.pool)
            .await
        } else {
            sqlx::query_as(
                r#"
                SELECT draft_uuid, label, content, community_id, created_at, updated_at
                FROM flora_core.post_drafts
                WHERE author_user_uuid = $1
                  AND community_id IS NULL
                ORDER BY updated_at DESC, created_at DESC
                "#,
            )
            .bind(author)
            .fetch_all(&self.pool)
            .await
        }
    }

    pub async fn count_post_drafts_in_scope(
        &self,
        author: Uuid,
        community_id: Option<Uuid>,
    ) -> Result<i64, sqlx::Error> {
        if let Some(cid) = community_id {
            sqlx::query_scalar(
                r#"
                SELECT COUNT(*)::bigint
                FROM flora_core.post_drafts
                WHERE author_user_uuid = $1
                  AND community_id = $2
                "#,
            )
            .bind(author)
            .bind(cid)
            .fetch_one(&self.pool)
            .await
        } else {
            sqlx::query_scalar(
                r#"
                SELECT COUNT(*)::bigint
                FROM flora_core.post_drafts
                WHERE author_user_uuid = $1
                  AND community_id IS NULL
                "#,
            )
            .bind(author)
            .fetch_one(&self.pool)
            .await
        }
    }

    #[allow(clippy::too_many_arguments)] // mirrors post_drafts INSERT columns
    pub async fn insert_post_draft(
        &self,
        draft_uuid: Uuid,
        author: Uuid,
        community_id: Option<Uuid>,
        label: &str,
        content: &str,
        created_at: DateTime<Utc>,
        updated_at: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.post_drafts
                (draft_uuid, author_user_uuid, community_id, label, content, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            "#,
        )
        .bind(draft_uuid)
        .bind(author)
        .bind(community_id)
        .bind(label)
        .bind(content)
        .bind(created_at)
        .bind(updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_post_draft(
        &self,
        draft_uuid: Uuid,
    ) -> Result<Option<PostDraftAuthRow>, sqlx::Error> {
        sqlx::query_as(
            r#"
            SELECT draft_uuid, author_user_uuid, label, content, community_id, created_at, updated_at
            FROM flora_core.post_drafts
            WHERE draft_uuid = $1
            "#,
        )
        .bind(draft_uuid)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn update_post_draft(
        &self,
        draft_uuid: Uuid,
        label: &str,
        content: &str,
        updated_at: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE flora_core.post_drafts
            SET label = $2, content = $3, updated_at = $4
            WHERE draft_uuid = $1
            "#,
        )
        .bind(draft_uuid)
        .bind(label)
        .bind(content)
        .bind(updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_post_draft(&self, draft_uuid: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            DELETE FROM flora_core.post_drafts
            WHERE draft_uuid = $1
            "#,
        )
        .bind(draft_uuid)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn video_status_by_post(
        &self,
        post_uuid: Uuid,
    ) -> Result<Option<VideoLite>, sqlx::Error> {
        sqlx::query_as(
            r#"
            SELECT post_uuid, uuid AS video_uuid, status, width, height, duration_ms
            FROM flora_core.post_videos
            WHERE post_uuid = $1
            LIMIT 1
            "#,
        )
        .bind(post_uuid)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn post_has_video(&self, post_uuid: Uuid) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM flora_core.post_videos
                WHERE post_uuid = $1
            )
            "#,
        )
        .bind(post_uuid)
        .fetch_one(&self.pool)
        .await
    }

    /// Вставка Processing-строки (пустые bytea, как дефолты EF/`PostVideo`).
    pub async fn insert_processing_video(
        &self,
        uuid: Uuid,
        post_uuid: Uuid,
        width: i32,
        height: i32,
        duration_ms: i32,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now();
        let empty: &[u8] = &[];
        sqlx::query(
            r#"
            INSERT INTO flora_core.post_videos (
                uuid, post_uuid, status, content_type, data,
                poster_data, poster_content_type,
                width, height, duration_ms, created_at
            )
            VALUES ($1, $2, 0, 'video/mp4', $3, $4, 'image/avif', $5, $6, $7, $8)
            "#,
        )
        .bind(uuid)
        .bind(post_uuid)
        .bind(empty)
        .bind(empty)
        .bind(width)
        .bind(height)
        .bind(duration_ms)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_video_for_update(&self, uuid: Uuid) -> Result<Option<Uuid>, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT uuid
            FROM flora_core.post_videos
            WHERE uuid = $1
            "#,
        )
        .bind(uuid)
        .fetch_optional(&self.pool)
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn update_video_ready(
        &self,
        uuid: Uuid,
        data: &[u8],
        content_type: &str,
        compatibility_data: Option<&[u8]>,
        compatibility_content_type: Option<&str>,
        poster_data: &[u8],
        poster_content_type: &str,
        width: i32,
        height: i32,
        duration_ms: i32,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE flora_core.post_videos
            SET data = $2,
                content_type = $3,
                compatibility_data = $4,
                compatibility_content_type = $5,
                poster_data = $6,
                poster_content_type = $7,
                width = $8,
                height = $9,
                duration_ms = $10,
                status = 1
            WHERE uuid = $1
            "#,
        )
        .bind(uuid)
        .bind(data)
        .bind(content_type)
        .bind(compatibility_data)
        .bind(compatibility_content_type)
        .bind(poster_data)
        .bind(poster_content_type)
        .bind(width)
        .bind(height)
        .bind(duration_ms)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn update_video_failed(&self, uuid: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE flora_core.post_videos
            SET status = 2
            WHERE uuid = $1
            "#,
        )
        .bind(uuid)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn fail_stale_processing_videos(
        &self,
        threshold: DateTime<Utc>,
    ) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            r#"
            UPDATE flora_core.post_videos
            SET status = 2
            WHERE status = 0
              AND created_at < $1
            "#,
        )
        .bind(threshold)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    pub async fn community_avatar_by_uuid(
        &self,
        uuid: Uuid,
    ) -> Result<Option<MediaBlob>, sqlx::Error> {
        let row: Option<MediaRow> = sqlx::query_as(
            r#"
            SELECT data, content_type
            FROM flora_core.community_avatars
            WHERE uuid = $1
            "#,
        )
        .bind(uuid)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.filter(|r| !r.data.is_empty()).map(|r| MediaBlob {
            data: r.data,
            content_type: r.content_type,
        }))
    }

    pub async fn post_video_by_uuid(
        &self,
        uuid: Uuid,
    ) -> Result<Option<PostMediaBlob>, sqlx::Error> {
        let row: Option<VideoRow> = sqlx::query_as(
            r#"
            SELECT post_uuid, data, content_type, status
            FROM flora_core.post_videos
            WHERE uuid = $1
            "#,
        )
        .bind(uuid)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row
            .filter(|r| r.status == 1 && !r.data.is_empty())
            .map(|r| PostMediaBlob {
                post_uuid: r.post_uuid,
                blob: MediaBlob {
                    data: r.data,
                    content_type: r.content_type,
                },
            }))
    }

    pub async fn post_video_poster_by_uuid(
        &self,
        uuid: Uuid,
    ) -> Result<Option<PostMediaBlob>, sqlx::Error> {
        let row: Option<PosterRow> = sqlx::query_as(
            r#"
            SELECT post_uuid, poster_data, poster_content_type
            FROM flora_core.post_videos
            WHERE uuid = $1
            "#,
        )
        .bind(uuid)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row
            .filter(|r| !r.poster_data.is_empty())
            .map(|r| PostMediaBlob {
                post_uuid: r.post_uuid,
                blob: MediaBlob {
                    data: r.poster_data,
                    content_type: r.poster_content_type,
                },
            }))
    }

    pub async fn list_public_communities(&self) -> Result<Vec<CommunityRow>, sqlx::Error> {
        sqlx::query_as(
            r#"
            SELECT community_id, name, slug, avatar_uuid, is_private, created_at
            FROM flora_core.communities
            WHERE is_private = false
            ORDER BY name
            "#,
        )
        .fetch_all(&self.pool)
        .await
    }

    pub async fn owned_communities(
        &self,
        user_uuid: Uuid,
    ) -> Result<Vec<CommunityRow>, sqlx::Error> {
        sqlx::query_as(
            r#"
            SELECT c.community_id, c.name, c.slug, c.avatar_uuid, c.is_private, c.created_at
            FROM flora_core.user_communities uc
            INNER JOIN flora_core.communities c ON c.community_id = uc.community_id
            WHERE uc.user_uuid = $1
              AND uc.role = 'Owner'
            "#,
        )
        .bind(user_uuid)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn member_counts(
        &self,
        community_ids: &[Uuid],
    ) -> Result<HashMap<Uuid, i32>, sqlx::Error> {
        if community_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows: Vec<(Uuid, i64)> = sqlx::query_as(
            r#"
            SELECT community_id, COUNT(*)::bigint
            FROM flora_core.user_communities
            WHERE community_id = ANY($1)
            GROUP BY community_id
            "#,
        )
        .bind(community_ids)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(id, count)| (id, count as i32))
            .collect())
    }

    pub async fn member_count(&self, community_id: Uuid) -> Result<i32, sqlx::Error> {
        let count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM flora_core.user_communities
            WHERE community_id = $1
            "#,
        )
        .bind(community_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(count as i32)
    }

    pub async fn community_by_slug(&self, slug: &str) -> Result<Option<CommunityRow>, sqlx::Error> {
        sqlx::query_as(
            r#"
            SELECT community_id, name, slug, avatar_uuid, is_private, created_at
            FROM flora_core.communities
            WHERE slug = $1
            "#,
        )
        .bind(slug)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn community_by_id(
        &self,
        community_id: Uuid,
    ) -> Result<Option<CommunityRow>, sqlx::Error> {
        sqlx::query_as(
            r#"
            SELECT community_id, name, slug, avatar_uuid, is_private, created_at
            FROM flora_core.communities
            WHERE community_id = $1
            "#,
        )
        .bind(community_id)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn community_meta(
        &self,
        community_id: Uuid,
    ) -> Result<Option<CommunityMeta>, sqlx::Error> {
        sqlx::query_as(
            r#"
            SELECT is_private
            FROM flora_core.communities
            WHERE community_id = $1
            "#,
        )
        .bind(community_id)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn user_role_in_community(
        &self,
        user_uuid: Uuid,
        community_id: Uuid,
    ) -> Result<Option<String>, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT role
            FROM flora_core.user_communities
            WHERE user_uuid = $1
              AND community_id = $2
            "#,
        )
        .bind(user_uuid)
        .bind(community_id)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn user_roles_in_communities(
        &self,
        user_uuid: Uuid,
        community_ids: &[Uuid],
    ) -> Result<HashMap<Uuid, String>, sqlx::Error> {
        if community_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows: Vec<(Uuid, String)> = sqlx::query_as(
            r#"
            SELECT community_id, role
            FROM flora_core.user_communities
            WHERE user_uuid = $1
              AND community_id = ANY($2)
            "#,
        )
        .bind(user_uuid)
        .bind(community_ids)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().collect())
    }

    pub async fn search_communities(
        &self,
        user_uuid: Uuid,
        query_lower: &str,
        skip: i32,
        take: i32,
    ) -> Result<Vec<CommunityRow>, sqlx::Error> {
        let pattern = format!("%{query_lower}%");
        sqlx::query_as(
            r#"
            SELECT c.community_id, c.name, c.slug, c.avatar_uuid, c.is_private, c.created_at
            FROM flora_core.communities c
            WHERE (LOWER(c.name) LIKE $1 OR LOWER(c.slug) LIKE $1)
              AND (
                  c.is_private = false
                  OR EXISTS (
                      SELECT 1
                      FROM flora_core.user_communities uc
                      WHERE uc.community_id = c.community_id
                        AND uc.user_uuid = $2
                        AND uc.role = 'Owner'
                  )
              )
            ORDER BY c.name
            OFFSET $3
            LIMIT $4
            "#,
        )
        .bind(pattern)
        .bind(user_uuid)
        .bind(i64::from(skip))
        .bind(i64::from(take))
        .fetch_all(&self.pool)
        .await
    }

    pub async fn profile_public_member_communities(
        &self,
        user_uuid: Uuid,
    ) -> Result<Vec<CommunityNameSlug>, sqlx::Error> {
        sqlx::query_as(
            r#"
            SELECT c.name, c.slug
            FROM flora_core.user_communities uc
            INNER JOIN flora_core.communities c ON c.community_id = uc.community_id
            WHERE uc.user_uuid = $1
              AND uc.role <> 'Owner'
              AND c.is_private = false
              AND uc.community_id NOT IN (
                  SELECT uc2.community_id
                  FROM flora_core.user_communities uc2
                  WHERE uc2.user_uuid = $1
                    AND uc2.role = 'Owner'
              )
            "#,
        )
        .bind(user_uuid)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn slug_exists(&self, slug: &str) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM flora_core.communities
                WHERE slug = $1
            )
            "#,
        )
        .bind(slug)
        .fetch_one(&self.pool)
        .await
    }

    pub async fn insert_community(
        &self,
        community_id: Uuid,
        name: &str,
        slug: &str,
        is_private: bool,
        created_at: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.communities
                (community_id, name, slug, is_private, created_at)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(community_id)
        .bind(name)
        .bind(slug)
        .bind(is_private)
        .bind(created_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn insert_membership(
        &self,
        user_uuid: Uuid,
        community_id: Uuid,
        role: &str,
        joined_at: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.user_communities
                (user_uuid, community_id, role, joined_at)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(user_uuid)
        .bind(community_id)
        .bind(role)
        .bind(joined_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn membership(
        &self,
        user_uuid: Uuid,
        community_id: Uuid,
    ) -> Result<Option<MembershipRow>, sqlx::Error> {
        sqlx::query_as(
            r#"
            SELECT role
            FROM flora_core.user_communities
            WHERE user_uuid = $1
              AND community_id = $2
            "#,
        )
        .bind(user_uuid)
        .bind(community_id)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn remove_membership(
        &self,
        user_uuid: Uuid,
        community_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            DELETE FROM flora_core.user_communities
            WHERE user_uuid = $1
              AND community_id = $2
            "#,
        )
        .bind(user_uuid)
        .bind(community_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Полное удаление сообщества и зависимых строк (аватар, посты, черновики, dismissals, membership).
    /// Порядок важен: сначала `communities.avatar_uuid`, иначе круговой FK с `community_avatars`.
    pub async fn purge_community(
        &self,
        community_id: Uuid,
        deleted_at: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;

        sqlx::query(
            r#"
            UPDATE flora_core.communities
            SET avatar_uuid = NULL
            WHERE community_id = $1
            "#,
        )
        .bind(community_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            DELETE FROM flora_core.community_avatars
            WHERE community_id = $1
            "#,
        )
        .bind(community_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            UPDATE flora_core.user_posts
            SET is_deleted = true, deleted_at = $2
            WHERE community_id = $1
              AND is_deleted = false
            "#,
        )
        .bind(community_id)
        .bind(deleted_at)
        .execute(&mut *tx)
        .await?;

        // Снимаем FK/ссылку, чтобы DELETE communities не упирался в оставшиеся soft-deleted посты.
        sqlx::query(
            r#"
            UPDATE flora_core.user_posts
            SET community_id = NULL
            WHERE community_id = $1
            "#,
        )
        .bind(community_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            DELETE FROM flora_core.post_drafts
            WHERE community_id = $1
            "#,
        )
        .bind(community_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            DELETE FROM flora_core.user_feed_community_dismissals
            WHERE community_id = $1
            "#,
        )
        .bind(community_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            DELETE FROM flora_core.user_communities
            WHERE community_id = $1
            "#,
        )
        .bind(community_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            DELETE FROM flora_core.communities
            WHERE community_id = $1
            "#,
        )
        .bind(community_id)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(())
    }

    pub async fn update_community(
        &self,
        community_id: Uuid,
        name: &str,
        slug: &str,
        is_private: bool,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE flora_core.communities
            SET name = $2, slug = $3, is_private = $4
            WHERE community_id = $1
            "#,
        )
        .bind(community_id)
        .bind(name)
        .bind(slug)
        .bind(is_private)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn community_posts(
        &self,
        community_id: Uuid,
        skip: i32,
        take: i32,
    ) -> Result<Vec<PostRow>, sqlx::Error> {
        sqlx::query_as(
            r#"
            SELECT post_uuid, content, created_at, author_user_uuid, community_id
            FROM flora_core.user_posts
            WHERE community_id = $1
              AND is_deleted = false
            ORDER BY created_at DESC
            OFFSET $2
            LIMIT $3
            "#,
        )
        .bind(community_id)
        .bind(i64::from(skip))
        .bind(i64::from(take))
        .fetch_all(&self.pool)
        .await
    }

    pub async fn recommendation_candidates(
        &self,
        user_uuid: Uuid,
        following_user_ids: &[Uuid],
        activity_since: DateTime<Utc>,
    ) -> Result<Vec<RecommendationCandidateRow>, sqlx::Error> {
        let communities: Vec<CommunityRow> = sqlx::query_as(
            r#"
            SELECT c.community_id, c.name, c.slug, c.avatar_uuid, c.is_private, c.created_at
            FROM flora_core.communities c
            WHERE c.is_private = false
              AND NOT EXISTS (
                  SELECT 1
                  FROM flora_core.user_communities uc
                  WHERE uc.community_id = c.community_id
                    AND uc.user_uuid = $1
              )
            "#,
        )
        .bind(user_uuid)
        .fetch_all(&self.pool)
        .await?;

        if communities.is_empty() {
            return Ok(Vec::new());
        }

        let community_ids: Vec<Uuid> = communities.iter().map(|c| c.community_id).collect();
        let member_counts = self.member_counts(&community_ids).await?;

        let recent_rows: Vec<(Uuid, i64)> = sqlx::query_as(
            r#"
            SELECT community_id, COUNT(*)::bigint
            FROM flora_core.user_posts
            WHERE community_id = ANY($1)
              AND is_deleted = false
              AND created_at >= $2
            GROUP BY community_id
            "#,
        )
        .bind(&community_ids)
        .bind(activity_since)
        .fetch_all(&self.pool)
        .await?;
        let recent_posts: HashMap<Uuid, i32> = recent_rows
            .into_iter()
            .map(|(id, c)| (id, c as i32))
            .collect();

        let followed_members: HashMap<Uuid, i32> = if following_user_ids.is_empty() {
            HashMap::new()
        } else {
            let rows: Vec<(Uuid, i64)> = sqlx::query_as(
                r#"
                SELECT community_id, COUNT(*)::bigint
                FROM flora_core.user_communities
                WHERE community_id = ANY($1)
                  AND user_uuid = ANY($2)
                GROUP BY community_id
                "#,
            )
            .bind(&community_ids)
            .bind(following_user_ids)
            .fetch_all(&self.pool)
            .await?;
            rows.into_iter().map(|(id, c)| (id, c as i32)).collect()
        };

        Ok(communities
            .into_iter()
            .map(|c| RecommendationCandidateRow {
                community_id: c.community_id,
                name: c.name,
                slug: c.slug,
                avatar_uuid: c.avatar_uuid,
                created_at: c.created_at,
                member_count: member_counts.get(&c.community_id).copied().unwrap_or(0),
                recent_post_count: recent_posts.get(&c.community_id).copied().unwrap_or(0),
                followed_members_count: followed_members.get(&c.community_id).copied().unwrap_or(0),
            })
            .collect())
    }

    async fn count_engagement(
        &self,
        table: &str,
        post_ids: &[Uuid],
        exclude_deleted_comments: bool,
    ) -> Result<HashMap<Uuid, i32>, sqlx::Error> {
        let rows = match table {
            "post_comments" if exclude_deleted_comments => {
                sqlx::query_as::<_, CountRow>(
                    r#"
                    SELECT post_uuid, COUNT(*)::bigint AS count
                    FROM flora_core.post_comments
                    WHERE post_uuid = ANY($1)
                      AND is_deleted = false
                    GROUP BY post_uuid
                    "#,
                )
                .bind(post_ids)
                .fetch_all(&self.pool)
                .await?
            }
            "post_likes" => {
                sqlx::query_as::<_, CountRow>(
                    r#"
                    SELECT post_uuid, COUNT(*)::bigint AS count
                    FROM flora_core.post_likes
                    WHERE post_uuid = ANY($1)
                    GROUP BY post_uuid
                    "#,
                )
                .bind(post_ids)
                .fetch_all(&self.pool)
                .await?
            }
            "post_reposts" => {
                sqlx::query_as::<_, CountRow>(
                    r#"
                    SELECT post_uuid, COUNT(*)::bigint AS count
                    FROM flora_core.post_reposts
                    WHERE post_uuid = ANY($1)
                    GROUP BY post_uuid
                    "#,
                )
                .bind(post_ids)
                .fetch_all(&self.pool)
                .await?
            }
            _ => Vec::new(),
        };
        Ok(rows
            .into_iter()
            .map(|r| (r.post_uuid, r.count as i32))
            .collect())
    }

    async fn count_since(
        &self,
        table: &str,
        time_column: &str,
        post_ids: &[Uuid],
        cutoff: DateTime<Utc>,
        exclude_deleted_comments: bool,
    ) -> Result<HashMap<Uuid, i32>, sqlx::Error> {
        let rows = match (table, time_column) {
            ("post_likes", "created_at") => {
                sqlx::query_as::<_, CountRow>(
                    r#"
                    SELECT post_uuid, COUNT(*)::bigint AS count
                    FROM flora_core.post_likes
                    WHERE post_uuid = ANY($1)
                      AND created_at >= $2
                    GROUP BY post_uuid
                    "#,
                )
                .bind(post_ids)
                .bind(cutoff)
                .fetch_all(&self.pool)
                .await?
            }
            ("post_comments", "created_at") if exclude_deleted_comments => {
                sqlx::query_as::<_, CountRow>(
                    r#"
                    SELECT post_uuid, COUNT(*)::bigint AS count
                    FROM flora_core.post_comments
                    WHERE post_uuid = ANY($1)
                      AND is_deleted = false
                      AND created_at >= $2
                    GROUP BY post_uuid
                    "#,
                )
                .bind(post_ids)
                .bind(cutoff)
                .fetch_all(&self.pool)
                .await?
            }
            ("post_reposts", "created_at") => {
                sqlx::query_as::<_, CountRow>(
                    r#"
                    SELECT post_uuid, COUNT(*)::bigint AS count
                    FROM flora_core.post_reposts
                    WHERE post_uuid = ANY($1)
                      AND created_at >= $2
                    GROUP BY post_uuid
                    "#,
                )
                .bind(post_ids)
                .bind(cutoff)
                .fetch_all(&self.pool)
                .await?
            }
            ("post_views", "viewed_at") => {
                sqlx::query_as::<_, CountRow>(
                    r#"
                    SELECT post_uuid, COUNT(*)::bigint AS count
                    FROM flora_core.post_views
                    WHERE post_uuid = ANY($1)
                      AND viewed_at >= $2
                    GROUP BY post_uuid
                    "#,
                )
                .bind(post_ids)
                .bind(cutoff)
                .fetch_all(&self.pool)
                .await?
            }
            _ => Vec::new(),
        };
        Ok(rows
            .into_iter()
            .map(|r| (r.post_uuid, r.count as i32))
            .collect())
    }

    pub async fn insert_community_avatar(
        &self,
        uuid: Uuid,
        community_id: Uuid,
        content_type: &str,
        data: &[u8],
        created_at: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.community_avatars
                (uuid, community_id, content_type, data, created_at)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(uuid)
        .bind(community_id)
        .bind(content_type)
        .bind(data)
        .bind(created_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_community_avatar_uuid(
        &self,
        community_id: Uuid,
        avatar_uuid: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE flora_core.communities
            SET avatar_uuid = $2
            WHERE community_id = $1
            "#,
        )
        .bind(community_id)
        .bind(avatar_uuid)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    // ------------------------------------------------------------------
    // §User Controls (FIRA-F v1.1): настройки ленты и негативный фидбек.
    // Таблицы принадлежат Content-модулю (миграции flora-content).
    // ------------------------------------------------------------------

    pub async fn feed_settings(
        &self,
        user_uuid: Uuid,
    ) -> Result<Option<FeedSettingsRow>, sqlx::Error> {
        sqlx::query_as(
            r#"
            SELECT freshness, exploration, show_reposts, community_posts,
                   seen_posts, author_diversity, updated_at
            FROM flora_core.user_feed_settings
            WHERE user_uuid = $1
            "#,
        )
        .bind(user_uuid)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn upsert_feed_settings(
        &self,
        user_uuid: Uuid,
        row: &FeedSettingsRow,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.user_feed_settings
                (user_uuid, freshness, exploration, show_reposts, community_posts,
                 seen_posts, author_diversity, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (user_uuid) DO UPDATE SET
                freshness = EXCLUDED.freshness,
                exploration = EXCLUDED.exploration,
                show_reposts = EXCLUDED.show_reposts,
                community_posts = EXCLUDED.community_posts,
                seen_posts = EXCLUDED.seen_posts,
                author_diversity = EXCLUDED.author_diversity,
                updated_at = EXCLUDED.updated_at
            "#,
        )
        .bind(user_uuid)
        .bind(&row.freshness)
        .bind(&row.exploration)
        .bind(row.show_reposts)
        .bind(row.community_posts)
        .bind(&row.seen_posts)
        .bind(&row.author_diversity)
        .bind(row.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn insert_post_not_interested(
        &self,
        user_uuid: Uuid,
        post_uuid: Uuid,
        author_user_uuid: Uuid,
        created_at: DateTime<Utc>,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            r#"
            INSERT INTO flora_core.user_feed_post_feedback
                (user_uuid, post_uuid, author_user_uuid, created_at)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (user_uuid, post_uuid) DO NOTHING
            "#,
        )
        .bind(user_uuid)
        .bind(post_uuid)
        .bind(author_user_uuid)
        .bind(created_at)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn delete_post_not_interested(
        &self,
        user_uuid: Uuid,
        post_uuid: Uuid,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            r#"
            DELETE FROM flora_core.user_feed_post_feedback
            WHERE user_uuid = $1 AND post_uuid = $2
            "#,
        )
        .bind(user_uuid)
        .bind(post_uuid)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn clear_post_not_interested(&self, user_uuid: Uuid) -> Result<u64, sqlx::Error> {
        let result =
            sqlx::query(r#"DELETE FROM flora_core.user_feed_post_feedback WHERE user_uuid = $1"#)
                .bind(user_uuid)
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected())
    }

    /// Все посты с отметкой «не интересно» (жёсткое исключение из рекомендаций).
    pub async fn not_interested_post_ids(&self, user_uuid: Uuid) -> Result<Vec<Uuid>, sqlx::Error> {
        let rows: Vec<(Uuid,)> = sqlx::query_as(
            r#"
            SELECT post_uuid
            FROM flora_core.user_feed_post_feedback
            WHERE user_uuid = $1
            ORDER BY created_at DESC
            LIMIT 10000
            "#,
        )
        .bind(user_uuid)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|(id,)| id).collect())
    }

    /// Счётчик «не интересно» по авторам в окне истории (для мягкого штрафа скоринга).
    pub async fn not_interested_author_counts(
        &self,
        user_uuid: Uuid,
        since: DateTime<Utc>,
    ) -> Result<HashMap<Uuid, i32>, sqlx::Error> {
        let rows: Vec<(Uuid, i64)> = sqlx::query_as(
            r#"
            SELECT author_user_uuid, COUNT(*)::bigint
            FROM flora_core.user_feed_post_feedback
            WHERE user_uuid = $1
              AND created_at >= $2
            GROUP BY author_user_uuid
            "#,
        )
        .bind(user_uuid)
        .bind(since)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|(id, c)| (id, c as i32)).collect())
    }

    pub async fn insert_hidden_author(
        &self,
        user_uuid: Uuid,
        author_user_uuid: Uuid,
        created_at: DateTime<Utc>,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            r#"
            INSERT INTO flora_core.user_feed_hidden_authors
                (user_uuid, author_user_uuid, created_at)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_uuid, author_user_uuid) DO NOTHING
            "#,
        )
        .bind(user_uuid)
        .bind(author_user_uuid)
        .bind(created_at)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn delete_hidden_author(
        &self,
        user_uuid: Uuid,
        author_user_uuid: Uuid,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            r#"
            DELETE FROM flora_core.user_feed_hidden_authors
            WHERE user_uuid = $1 AND author_user_uuid = $2
            "#,
        )
        .bind(user_uuid)
        .bind(author_user_uuid)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn hidden_author_ids(&self, user_uuid: Uuid) -> Result<Vec<Uuid>, sqlx::Error> {
        let rows: Vec<(Uuid,)> = sqlx::query_as(
            r#"
            SELECT author_user_uuid
            FROM flora_core.user_feed_hidden_authors
            WHERE user_uuid = $1
            "#,
        )
        .bind(user_uuid)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|(id,)| id).collect())
    }

    /// Список скрытых авторов с датой скрытия (для страницы настроек).
    pub async fn hidden_authors_with_dates(
        &self,
        user_uuid: Uuid,
    ) -> Result<Vec<(Uuid, DateTime<Utc>)>, sqlx::Error> {
        sqlx::query_as(
            r#"
            SELECT author_user_uuid, created_at
            FROM flora_core.user_feed_hidden_authors
            WHERE user_uuid = $1
            ORDER BY created_at DESC
            "#,
        )
        .bind(user_uuid)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn insert_community_dismissal(
        &self,
        user_uuid: Uuid,
        community_id: Uuid,
        created_at: DateTime<Utc>,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            r#"
            INSERT INTO flora_core.user_feed_community_dismissals
                (user_uuid, community_id, created_at)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_uuid, community_id) DO NOTHING
            "#,
        )
        .bind(user_uuid)
        .bind(community_id)
        .bind(created_at)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn delete_community_dismissal(
        &self,
        user_uuid: Uuid,
        community_id: Uuid,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            r#"
            DELETE FROM flora_core.user_feed_community_dismissals
            WHERE user_uuid = $1 AND community_id = $2
            "#,
        )
        .bind(user_uuid)
        .bind(community_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn dismissed_community_ids(&self, user_uuid: Uuid) -> Result<Vec<Uuid>, sqlx::Error> {
        let rows: Vec<(Uuid,)> = sqlx::query_as(
            r#"
            SELECT community_id
            FROM flora_core.user_feed_community_dismissals
            WHERE user_uuid = $1
            ORDER BY created_at DESC
            "#,
        )
        .bind(user_uuid)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|(id,)| id).collect())
    }

    /// Просмотренные пользователем посты среди кандидатов (для Demote/Hide режимов).
    pub async fn seen_post_ids_among(
        &self,
        user_uuid: Uuid,
        post_ids: &[Uuid],
    ) -> Result<HashSet<Uuid>, sqlx::Error> {
        if post_ids.is_empty() {
            return Ok(HashSet::new());
        }
        let rows: Vec<(Uuid,)> = sqlx::query_as(
            r#"
            SELECT post_uuid
            FROM flora_core.post_views
            WHERE user_uuid = $1
              AND post_uuid = ANY($2)
            "#,
        )
        .bind(user_uuid)
        .bind(post_ids)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|(id,)| id).collect())
    }
}

/// Строка `user_feed_settings` (enum'ы храним текстом — контракт fira-contracts).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct FeedSettingsRow {
    pub freshness: String,
    pub exploration: String,
    pub show_reposts: bool,
    pub community_posts: bool,
    pub seen_posts: String,
    pub author_diversity: String,
    pub updated_at: DateTime<Utc>,
}
