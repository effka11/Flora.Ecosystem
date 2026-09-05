//! Сериализация страницы ленты — паритет `SerializeFeedPageAsync`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use flora_auth_contracts::AccountDirectory;
use flora_users_contracts::{
    AccountSanctionStatus, FeedAuthorProfile, FeedAuthorProfiles, FollowGraphReader, ProfileAccess,
    ProfileAccessField,
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
    account_sanction_status: Arc<dyn AccountSanctionStatus>,
}

impl FeedSerializer {
    pub fn new(
        repo: Arc<ContentRepo>,
        accounts: Arc<dyn AccountDirectory>,
        profiles: Arc<dyn FeedAuthorProfiles>,
        follow: Arc<dyn FollowGraphReader>,
        profile_access: Arc<dyn ProfileAccess>,
        account_sanction_status: Arc<dyn AccountSanctionStatus>,
    ) -> Self {
        Self {
            repo,
            accounts,
            profiles,
            follow,
            profile_access,
            account_sanction_status,
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

    async fn blocked_user_ids(&self, candidates: &[Uuid]) -> Result<HashSet<Uuid>, String> {
        if candidates.is_empty() {
            return Ok(HashSet::new());
        }
        Ok(self
            .account_sanction_status
            .blocked_among(candidates)
            .await?
            .into_iter()
            .collect())
    }

    pub async fn serialize_page(&self, viewer: Uuid, page: FeedPage) -> Result<Value, String> {
        let items = self
            .serialize_feed_post_dtos(viewer, &page.post_uuids)
            .await?;
        Ok(json!({
            "items": items,
            "nextCursor": page.next_cursor,
            "hasMore": page.has_more,
            "generatedAt": format_utc(page.generated_at),
            "expiresAt": format_utc(page.expires_at),
        }))
    }

    /// Те же карточки, что элементы страницы ленты, без cursor-обёртки.
    pub async fn serialize_feed_post_dtos(
        &self,
        viewer: Uuid,
        post_uuids: &[Uuid],
    ) -> Result<Vec<Value>, String> {
        if post_uuids.is_empty() {
            return Ok(Vec::new());
        }

        let requested_post_uuids = post_uuids.to_vec();
        let mut posts = self
            .repo
            .load_posts_ordered(&requested_post_uuids)
            .await
            .map_err(|e| e.to_string())?;
        let visible_post_ids = self.visible_post_ids(Some(viewer), &posts).await?;
        posts.retain(|post| visible_post_ids.contains(&post.post_uuid));
        if posts.is_empty() {
            return Ok(Vec::new());
        }

        let privacy_visible_post_uuids: Vec<Uuid> =
            posts.iter().map(|post| post.post_uuid).collect();
        let mut following_ids: HashSet<Uuid> = self
            .follow
            .following_user_ids(viewer)
            .await?
            .into_iter()
            .collect();
        following_ids.remove(&viewer);
        let followed_vec: Vec<Uuid> = following_ids.iter().copied().collect();
        let mut followed_reposters = if followed_vec.is_empty() {
            HashMap::new()
        } else {
            self.repo
                .followed_reposter_ids_by_posts(&privacy_visible_post_uuids, &followed_vec)
                .await
                .map_err(|e| e.to_string())?
        };

        let sanction_candidates: Vec<Uuid> = posts
            .iter()
            .map(|post| post.author_user_uuid)
            .chain(
                followed_reposters
                    .values()
                    .flat_map(|ids| ids.iter().copied()),
            )
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let blocked_user_ids = self.blocked_user_ids(&sanction_candidates).await?;
        retain_unblocked_posts(&mut posts, &blocked_user_ids);
        if posts.is_empty() {
            return Ok(Vec::new());
        }

        let post_uuids: Vec<Uuid> = posts.iter().map(|post| post.post_uuid).collect();
        let kept_post_ids: HashSet<Uuid> = post_uuids.iter().copied().collect();
        followed_reposters.retain(|post_uuid, ids| {
            ids.retain(|user_uuid| !blocked_user_ids.contains(user_uuid));
            kept_post_ids.contains(post_uuid)
        });

        let author_uuids: Vec<Uuid> = posts
            .iter()
            .map(|p| p.author_user_uuid)
            .collect::<HashSet<_>>()
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

        let reposter_uuids: Vec<Uuid> = followed_reposters
            .values()
            .flat_map(|v| v.iter().copied())
            .collect::<HashSet<_>>()
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
                let author_account_blocked = profile.map(|pr| pr.account_blocked).unwrap_or(false);

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

                let followed_reposts = followed_reposts_value(
                    followed_reposters.get(&p.post_uuid).map(Vec::as_slice),
                    &reposter_usernames,
                    &reposter_profiles,
                    &blocked_user_ids,
                );

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
                    "authorAccountBlocked": author_account_blocked,
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
                    "followedReposts": followed_reposts,
                })
            })
            .collect();

        Ok(items)
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
        let candidate_author_uuids: Vec<Uuid> = metadata
            .iter()
            .filter(|post| visible_post_ids.contains(&post.post_uuid))
            .map(|post| post.author_user_uuid)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let blocked_user_ids = self.blocked_user_ids(&candidate_author_uuids).await?;
        let author_by_post: HashMap<Uuid, Uuid> = metadata
            .iter()
            .map(|post| (post.post_uuid, post.author_user_uuid))
            .collect();
        posts.retain(|post| {
            visible_post_ids.contains(&post.post_uuid)
                && author_by_post
                    .get(&post.post_uuid)
                    .is_some_and(|author| !blocked_user_ids.contains(author))
        });
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
        let candidate_author_uuids: Vec<Uuid> = posts
            .iter()
            .filter(|post| visible_post_ids.contains(&post.post_uuid))
            .map(|post| post.author_user_uuid)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let blocked_user_ids = self.blocked_user_ids(&candidate_author_uuids).await?;
        let visible_posts: Vec<PostRow> = posts
            .iter()
            .filter(|post| {
                visible_post_ids.contains(&post.post_uuid)
                    && !blocked_user_ids.contains(&post.author_user_uuid)
            })
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
            .collect::<HashSet<_>>()
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
                let author_account_blocked = profile.map(|pr| pr.account_blocked).unwrap_or(false);

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
                    "authorAccountBlocked": author_account_blocked,
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

fn retain_unblocked_posts(posts: &mut Vec<PostRow>, blocked_user_ids: &HashSet<Uuid>) {
    posts.retain(|post| !blocked_user_ids.contains(&post.author_user_uuid));
}

fn followed_reposts_value(
    reposter_ids: Option<&[Uuid]>,
    usernames: &HashMap<Uuid, String>,
    profiles: &HashMap<Uuid, FeedAuthorProfile>,
    blocked_user_ids: &HashSet<Uuid>,
) -> Value {
    let Some(reposter_ids) = reposter_ids else {
        return Value::Null;
    };
    let items: Vec<Value> = reposter_ids
        .iter()
        .filter(|user_uuid| !blocked_user_ids.contains(user_uuid))
        .filter_map(|user_uuid| {
            let username = usernames.get(user_uuid).cloned().unwrap_or_default();
            if username.trim().is_empty() {
                return None;
            }
            let profile = profiles.get(user_uuid);
            let display_name = profile
                .map(|profile| {
                    if profile.display_name.is_empty() {
                        username.clone()
                    } else {
                        profile.display_name.clone()
                    }
                })
                .unwrap_or_else(|| username.clone());
            let avatar_uuid = profile.and_then(|p| p.avatar_uuid.map(|u| u.to_string()));
            let account_blocked = profile.map(|p| p.account_blocked).unwrap_or(false);
            Some(json!({
                "username": username,
                "displayName": display_name,
                "avatarUuid": avatar_uuid,
                "userUuid": user_uuid.to_string(),
                "accountBlocked": account_blocked,
            }))
        })
        .collect();
    if items.is_empty() {
        Value::Null
    } else {
        Value::Array(items)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocked_author_is_removed_from_feed_candidates() {
        let blocked = Uuid::from_u128(1);
        let visible = Uuid::from_u128(2);
        let mut posts = vec![
            PostRow {
                post_uuid: Uuid::from_u128(10),
                content: "blocked post".to_string(),
                created_at: chrono::DateTime::<chrono::Utc>::UNIX_EPOCH,
                author_user_uuid: blocked,
                community_id: None,
            },
            PostRow {
                post_uuid: Uuid::from_u128(11),
                content: "visible post".to_string(),
                created_at: chrono::DateTime::<chrono::Utc>::UNIX_EPOCH,
                author_user_uuid: visible,
                community_id: None,
            },
        ];

        retain_unblocked_posts(&mut posts, &HashSet::from([blocked]));

        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].author_user_uuid, visible);
    }

    #[test]
    fn blocked_reposter_is_removed_while_visible_stack_survives() {
        let blocked = Uuid::from_u128(1);
        let visible = Uuid::from_u128(2);
        let usernames = HashMap::from([
            (blocked, "blocked".to_string()),
            (visible, "visible".to_string()),
        ]);
        let profiles = HashMap::from([
            (
                blocked,
                FeedAuthorProfile {
                    user_uuid: blocked,
                    display_name: "Blocked".to_string(),
                    avatar_uuid: None,
                    account_blocked: true,
                },
            ),
            (
                visible,
                FeedAuthorProfile {
                    user_uuid: visible,
                    display_name: "Visible".to_string(),
                    avatar_uuid: Some(Uuid::from_u128(22)),
                    account_blocked: false,
                },
            ),
        ]);

        let value = followed_reposts_value(
            Some(&[blocked, visible]),
            &usernames,
            &profiles,
            &HashSet::from([blocked]),
        );

        assert_eq!(
            value,
            json!([{
                "username": "visible",
                "displayName": "Visible",
                "avatarUuid": Uuid::from_u128(22).to_string(),
                "userUuid": visible.to_string(),
                "accountBlocked": false,
            }])
        );
    }
}
