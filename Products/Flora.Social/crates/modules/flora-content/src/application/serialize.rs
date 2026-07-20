//! Сериализация страницы ленты — паритет `SerializeFeedPageAsync`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use flora_auth_contracts::AccountDirectory;
use flora_users_contracts::{
    FeedAuthorProfiles, FollowGraphReader, ProfileAccess, ProfileAccessField,
};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::application::feed::FeedPage;
use crate::application::time::format_utc;
use crate::infrastructure::repo::{ContentRepo, PostRow, ProfilePostRow};

pub struct FeedSerializer {
    repo: Arc<ContentRepo>,
    accounts: Arc<dyn AccountDirectory>,
    profiles: Arc<dyn FeedAuthorProfiles>,
    follow: Arc<dyn FollowGraphReader>,
    profile_access: Arc<dyn ProfileAccess>,
}

impl FeedSerializer {
    pub fn new(
        repo: Arc<ContentRepo>,
        accounts: Arc<dyn AccountDirectory>,
        profiles: Arc<dyn FeedAuthorProfiles>,
        follow: Arc<dyn FollowGraphReader>,
        profile_access: Arc<dyn ProfileAccess>,
    ) -> Self {
        Self {
            repo,
            accounts,
            profiles,
            follow,
            profile_access,
        }
    }

    async fn visible_post_ids(
        &self,
        viewer: Option<Uuid>,
        posts: &[PostRow],
    ) -> Result<HashSet<Uuid>, String> {
        let personal_authors: Vec<Uuid> = posts
            .iter()
            .filter(|post| post.community_id.is_none())
            .map(|post| post.author_user_uuid)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let community_ids: Vec<Uuid> = posts
            .iter()
            .filter_map(|post| post.community_id)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let visible_personal_authors: HashSet<Uuid> = self
            .profile_access
            .accessible_owners(viewer, &personal_authors, ProfileAccessField::Posts)
            .await?
            .into_iter()
            .collect();
        let visible_communities: HashSet<Uuid> = self
            .repo
            .accessible_community_ids(&community_ids, viewer)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .collect();
        Ok(posts
            .iter()
            .filter(|post| match post.community_id {
                Some(community_id) => visible_communities.contains(&community_id),
                None => visible_personal_authors.contains(&post.author_user_uuid),
            })
            .map(|post| post.post_uuid)
            .collect())
    }

    pub async fn serialize_page(&self, viewer: Uuid, page: FeedPage) -> Result<Value, String> {
        if page.post_uuids.is_empty() {
            return Ok(json!({
                "items": [],
                "nextCursor": page.next_cursor,
                "hasMore": page.has_more,
                "generatedAt": format_utc(page.generated_at),
                "expiresAt": format_utc(page.expires_at),
            }));
        }

        let requested_post_uuids = page.post_uuids.clone();
        let mut posts = self
            .repo
            .load_posts_ordered(&requested_post_uuids)
            .await
            .map_err(|e| e.to_string())?;
        let visible_post_ids = self.visible_post_ids(Some(viewer), &posts).await?;
        posts.retain(|post| visible_post_ids.contains(&post.post_uuid));
        let post_uuids: Vec<Uuid> = posts.iter().map(|post| post.post_uuid).collect();

        let author_uuids: Vec<Uuid> = posts
            .iter()
            .map(|p| p.author_user_uuid)
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();

        let usernames = self
            .accounts
            .usernames_by_uuids(&author_uuids)
            .await?
            .into_iter()
            .collect::<HashMap<_, _>>();
        let profiles = self
            .profiles
            .by_uuids(&author_uuids)
            .await?
            .into_iter()
            .map(|p| (p.user_uuid, p))
            .collect::<HashMap<_, _>>();

        let community_ids: Vec<Uuid> = posts
            .iter()
            .filter_map(|p| p.community_id)
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();
        let communities = self
            .repo
            .communities_by_ids(&community_ids)
            .await
            .map_err(|e| e.to_string())?;
        let community_by: HashMap<Uuid, _> = communities
            .into_iter()
            .map(|c| (c.community_id, c))
            .collect();

        let comment_counts = self
            .repo
            .count_by_post("post_comments", &post_uuids, true)
            .await
            .map_err(|e| e.to_string())?;
        let like_counts = self
            .repo
            .count_by_post("post_likes", &post_uuids, false)
            .await
            .map_err(|e| e.to_string())?;
        let repost_counts = self
            .repo
            .count_by_post("post_reposts", &post_uuids, false)
            .await
            .map_err(|e| e.to_string())?;
        let view_counts = self
            .repo
            .count_by_post("post_views", &post_uuids, false)
            .await
            .map_err(|e| e.to_string())?;

        let (liked, reposted, commented) = self
            .repo
            .viewer_flags(viewer, &post_uuids)
            .await
            .map_err(|e| e.to_string())?;
        let images = self
            .repo
            .image_uuids_by_posts(&post_uuids)
            .await
            .map_err(|e| e.to_string())?;
        let videos = self
            .repo
            .videos_by_posts(&post_uuids)
            .await
            .map_err(|e| e.to_string())?;

        let mut following_ids: std::collections::HashSet<Uuid> = self
            .follow
            .following_user_ids(viewer)
            .await?
            .into_iter()
            .collect();
        following_ids.remove(&viewer);
        let followed_vec: Vec<Uuid> = following_ids.iter().copied().collect();
        let followed_reposters = if followed_vec.is_empty() {
            HashMap::new()
        } else {
            self.repo
                .followed_reposter_ids_by_posts(&post_uuids, &followed_vec)
                .await
                .map_err(|e| e.to_string())?
        };

        let mut reposter_uuids: Vec<Uuid> = followed_reposters
            .values()
            .flat_map(|v| v.iter().copied())
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();
        let reposter_usernames = if reposter_uuids.is_empty() {
            HashMap::new()
        } else {
            self.accounts
                .usernames_by_uuids(&reposter_uuids)
                .await?
                .into_iter()
                .collect()
        };
        let reposter_profiles = if reposter_uuids.is_empty() {
            HashMap::new()
        } else {
            self.profiles
                .by_uuids(&reposter_uuids)
                .await?
                .into_iter()
                .map(|p| (p.user_uuid, p))
                .collect()
        };
        let _ = &mut reposter_uuids;

        let items: Vec<Value> = posts
            .iter()
            .map(|p| {
                let username = usernames
                    .get(&p.author_user_uuid)
                    .cloned()
                    .unwrap_or_default();
                let profile = profiles.get(&p.author_user_uuid);
                let display = profile
                    .map(|pr| {
                        if pr.display_name.is_empty() {
                            username.clone()
                        } else {
                            pr.display_name.clone()
                        }
                    })
                    .unwrap_or_else(|| username.clone());
                let avatar = profile.and_then(|pr| pr.avatar_uuid.map(|u| u.to_string()));

                let (cname, cslug, cavatar) = if let Some(cid) = p.community_id {
                    if let Some(c) = community_by.get(&cid) {
                        (
                            Some(c.name.clone()),
                            Some(c.slug.clone()),
                            c.avatar_uuid.map(|u| u.to_string()),
                        )
                    } else {
                        (None, None, None)
                    }
                } else {
                    (None, None, None)
                };

                let mut followed_repost_items = Vec::new();
                if let Some(ids) = followed_reposters.get(&p.post_uuid) {
                    for rid in ids {
                        let uname = reposter_usernames.get(rid).cloned().unwrap_or_default();
                        if uname.trim().is_empty() {
                            continue;
                        }
                        let dname = reposter_profiles
                            .get(rid)
                            .map(|pr| {
                                if pr.display_name.is_empty() {
                                    uname.clone()
                                } else {
                                    pr.display_name.clone()
                                }
                            })
                            .unwrap_or_else(|| uname.clone());
                        followed_repost_items.push(json!({
                            "username": uname,
                            "displayName": dname,
                        }));
                    }
                }

                let video = videos.get(&p.post_uuid).map(|v| {
                    let status = match v.status {
                        1 => "ready",
                        2 => "failed",
                        _ => "processing",
                    };
                    json!({
                        "videoUuid": v.video_uuid,
                        "status": status,
                        "width": v.width,
                        "height": v.height,
                        "durationMs": v.duration_ms,
                    })
                });

                let image_uuids = images.get(&p.post_uuid).cloned().unwrap_or_default();

                json!({
                    "postUuid": p.post_uuid,
                    "content": p.content,
                    "createdAt": format_utc(p.created_at),
                    "authorUserUuid": p.author_user_uuid,
                    "authorUsername": username,
                    "authorDisplayName": display,
                    "authorAvatarUuid": avatar,
                    "communityId": p.community_id,
                    "communityName": cname,
                    "communitySlug": cslug,
                    "communityAvatarUuid": cavatar,
                    "imageUuids": image_uuids,
                    "video": video,
                    "commentsCount": comment_counts.get(&p.post_uuid).copied().unwrap_or(0),
                    "likesCount": like_counts.get(&p.post_uuid).copied().unwrap_or(0),
                    "repostsCount": repost_counts.get(&p.post_uuid).copied().unwrap_or(0),
                    "viewsCount": view_counts.get(&p.post_uuid).copied().unwrap_or(0),
                    "liked": liked.contains(&p.post_uuid),
                    "reposted": reposted.contains(&p.post_uuid),
                    "hasCommented": commented.contains(&p.post_uuid),
                    "followedReposts": if followed_repost_items.is_empty() {
                        Value::Null
                    } else {
                        Value::Array(followed_repost_items)
                    },
                })
            })
            .collect();

        Ok(json!({
            "items": items,
            "nextCursor": page.next_cursor,
            "hasMore": page.has_more,
            "generatedAt": format_utc(page.generated_at),
            "expiresAt": format_utc(page.expires_at),
        }))
    }

    /// Паритет `BuildProfilePostsPayloadAsync` (секции posts/likes/reposts профиля).
    pub async fn serialize_profile_posts(
        &self,
        mut posts: Vec<ProfilePostRow>,
        viewer: Option<Uuid>,
    ) -> Result<Value, String> {
        if posts.is_empty() {
            return Ok(Value::Array(vec![]));
        }

        let requested_post_uuids: Vec<Uuid> = posts.iter().map(|post| post.post_uuid).collect();
        let metadata = self
            .repo
            .load_posts_ordered(&requested_post_uuids)
            .await
            .map_err(|e| e.to_string())?;
        let visible_post_ids = self.visible_post_ids(viewer, &metadata).await?;
        posts.retain(|post| visible_post_ids.contains(&post.post_uuid));
        if posts.is_empty() {
            return Ok(Value::Array(vec![]));
        }

        let post_uuids: Vec<Uuid> = posts.iter().map(|p| p.post_uuid).collect();

        let comment_counts = self
            .repo
            .count_by_post("post_comments", &post_uuids, true)
            .await
            .map_err(|e| e.to_string())?;
        let like_counts = self
            .repo
            .count_by_post("post_likes", &post_uuids, false)
            .await
            .map_err(|e| e.to_string())?;
        let repost_counts = self
            .repo
            .count_by_post("post_reposts", &post_uuids, false)
            .await
            .map_err(|e| e.to_string())?;
        let view_counts = self
            .repo
            .count_by_post("post_views", &post_uuids, false)
            .await
            .map_err(|e| e.to_string())?;

        let (liked, reposted, commented) = if let Some(viewer) = viewer {
            self.repo
                .viewer_flags(viewer, &post_uuids)
                .await
                .map_err(|e| e.to_string())?
        } else {
            (HashSet::new(), HashSet::new(), HashSet::new())
        };

        let images = self
            .repo
            .image_uuids_by_posts(&post_uuids)
            .await
            .map_err(|e| e.to_string())?;
        let videos = self
            .repo
            .videos_by_posts(&post_uuids)
            .await
            .map_err(|e| e.to_string())?;

        let items: Vec<Value> = posts
            .iter()
            .map(|p| {
                let video = videos.get(&p.post_uuid).map(|v| {
                    let status = match v.status {
                        1 => "ready",
                        2 => "failed",
                        _ => "processing",
                    };
                    json!({
                        "videoUuid": v.video_uuid,
                        "status": status,
                        "width": v.width,
                        "height": v.height,
                        "durationMs": v.duration_ms,
                    })
                });

                json!({
                    "postUuid": p.post_uuid,
                    "content": p.content,
                    "createdAt": format_utc(p.created_at),
                    "imageUuids": images.get(&p.post_uuid).cloned().unwrap_or_default(),
                    "video": video,
                    "commentsCount": comment_counts.get(&p.post_uuid).copied().unwrap_or(0),
                    "likesCount": like_counts.get(&p.post_uuid).copied().unwrap_or(0),
                    "repostsCount": repost_counts.get(&p.post_uuid).copied().unwrap_or(0),
                    "viewsCount": view_counts.get(&p.post_uuid).copied().unwrap_or(0),
                    "liked": liked.contains(&p.post_uuid),
                    "reposted": reposted.contains(&p.post_uuid),
                    "hasCommented": commented.contains(&p.post_uuid),
                })
            })
            .collect();

        Ok(Value::Array(items))
    }

    /// Карточки постов сообщества — паритет `GetCommunityPosts` (с данными автора).
    pub async fn serialize_post_cards(
        &self,
        viewer: Option<Uuid>,
        posts: &[crate::infrastructure::repo::PostRow],
    ) -> Result<Vec<Value>, String> {
        if posts.is_empty() {
            return Ok(Vec::new());
        }
        let visible_post_ids = self.visible_post_ids(viewer, posts).await?;
        let visible_posts: Vec<PostRow> = posts
            .iter()
            .filter(|post| visible_post_ids.contains(&post.post_uuid))
            .cloned()
            .collect();
        if visible_posts.is_empty() {
            return Ok(Vec::new());
        }
        let posts = visible_posts.as_slice();

        let post_uuids: Vec<Uuid> = posts.iter().map(|p| p.post_uuid).collect();
        let author_uuids: Vec<Uuid> = posts
            .iter()
            .map(|p| p.author_user_uuid)
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();

        let usernames = self
            .accounts
            .usernames_by_uuids(&author_uuids)
            .await?
            .into_iter()
            .collect::<HashMap<_, _>>();
        let profiles = self
            .profiles
            .by_uuids(&author_uuids)
            .await?
            .into_iter()
            .map(|p| (p.user_uuid, p))
            .collect::<HashMap<_, _>>();

        let comment_counts = self
            .repo
            .count_by_post("post_comments", &post_uuids, true)
            .await
            .map_err(|e| e.to_string())?;
        let like_counts = self
            .repo
            .count_by_post("post_likes", &post_uuids, false)
            .await
            .map_err(|e| e.to_string())?;
        let repost_counts = self
            .repo
            .count_by_post("post_reposts", &post_uuids, false)
            .await
            .map_err(|e| e.to_string())?;
        let view_counts = self
            .repo
            .count_by_post("post_views", &post_uuids, false)
            .await
            .map_err(|e| e.to_string())?;

        let (liked, reposted, commented) = if let Some(viewer) = viewer {
            self.repo
                .viewer_flags(viewer, &post_uuids)
                .await
                .map_err(|e| e.to_string())?
        } else {
            (HashSet::new(), HashSet::new(), HashSet::new())
        };

        let images = self
            .repo
            .image_uuids_by_posts(&post_uuids)
            .await
            .map_err(|e| e.to_string())?;
        let videos = self
            .repo
            .videos_by_posts(&post_uuids)
            .await
            .map_err(|e| e.to_string())?;

        Ok(posts
            .iter()
            .map(|p| {
                let username = usernames
                    .get(&p.author_user_uuid)
                    .cloned()
                    .unwrap_or_default();
                let profile = profiles.get(&p.author_user_uuid);
                let display = profile
                    .map(|pr| {
                        if pr.display_name.is_empty() {
                            username.clone()
                        } else {
                            pr.display_name.clone()
                        }
                    })
                    .unwrap_or_else(|| username.clone());
                let avatar = profile.and_then(|pr| pr.avatar_uuid);

                let video = videos.get(&p.post_uuid).map(|v| {
                    let status = match v.status {
                        1 => "ready",
                        2 => "failed",
                        _ => "processing",
                    };
                    json!({
                        "videoUuid": v.video_uuid,
                        "status": status,
                        "width": v.width,
                        "height": v.height,
                        "durationMs": v.duration_ms,
                    })
                });

                json!({
                    "postUuid": p.post_uuid,
                    "content": p.content,
                    "createdAt": format_utc(p.created_at),
                    "authorUserUuid": p.author_user_uuid,
                    "authorUsername": username,
                    "authorDisplayName": display,
                    "authorAvatarUuid": avatar,
                    "imageUuids": images.get(&p.post_uuid).cloned().unwrap_or_default(),
                    "video": video,
                    "commentsCount": comment_counts.get(&p.post_uuid).copied().unwrap_or(0),
                    "likesCount": like_counts.get(&p.post_uuid).copied().unwrap_or(0),
                    "repostsCount": repost_counts.get(&p.post_uuid).copied().unwrap_or(0),
                    "viewsCount": view_counts.get(&p.post_uuid).copied().unwrap_or(0),
                    "liked": liked.contains(&p.post_uuid),
                    "reposted": reposted.contains(&p.post_uuid),
                    "hasCommented": commented.contains(&p.post_uuid),
                })
            })
            .collect())
    }
}
