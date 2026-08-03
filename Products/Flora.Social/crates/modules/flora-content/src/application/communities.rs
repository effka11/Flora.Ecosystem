//! Сообщества — порт `ImportedSocialController` communities routes (~2060–2637).

use std::sync::Arc;

use chrono::Utc;
use flora_auth_contracts::AccountDirectory;
use flora_shared::flora_uuid::new_uuid;
use flora_shared::latin_identifiers::{SLUG_FORMAT_MESSAGE, has_only_slug_chars, normalize_slug};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::application::community_recommendation::CommunityRecommendationService;
use crate::application::feed::FeedService;
use crate::application::post_image_processor::{PostImageProcessError, process_avatar_image};
use crate::application::reserved_slugs::{is_reserved, normalize_for_compare};
use crate::application::serialize::FeedSerializer;
use crate::infrastructure::repo::{CommunityRow, ContentRepo};

pub const ALLOWED_COMMUNITY_AVATAR_TYPES: &[&str] = &["image/jpeg", "image/png", "image/webp"];
pub const MAX_COMMUNITY_AVATAR_BYTES: usize = 2 * 1024 * 1024;

pub struct CommunitiesService {
    repo: Arc<ContentRepo>,
    accounts: Arc<dyn AccountDirectory>,
    serialize: Arc<FeedSerializer>,
    feed: Arc<FeedService>,
    recommendations: Arc<CommunityRecommendationService>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommunityError {
    NotFound,
    NotFoundEdit,
    NotFoundDelete,
    UserNotFound,
    PrivateCommunity,
    AlreadyMember,
    OwnerCannotLeave,
    SlugTaken,
    SlugReserved,
    Forbidden,
    BadRequest(&'static str),
}

pub struct CommunityAvatarUpload {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

pub enum UploadCommunityAvatarError {
    Forbidden,
    NotFound,
    NoFile,
    FileTooLarge,
    BadType,
    Unreadable,
}

impl CommunitiesService {
    pub fn new(
        repo: Arc<ContentRepo>,
        accounts: Arc<dyn AccountDirectory>,
        serialize: Arc<FeedSerializer>,
        feed: Arc<FeedService>,
        recommendations: Arc<CommunityRecommendationService>,
    ) -> Self {
        Self {
            repo,
            accounts,
            serialize,
            feed,
            recommendations,
        }
    }

    pub async fn get_recommended(&self, user_uuid: Uuid, take: i32) -> Result<Value, String> {
        self.recommendations.get_recommended(user_uuid, take).await
    }

    pub async fn list_public(&self) -> Result<Vec<Value>, String> {
        let communities = self
            .repo
            .list_public_communities()
            .await
            .map_err(|e| e.to_string())?;
        self.serialize_community_list(&communities, None, false)
            .await
    }

    pub async fn list_owned(&self, user_uuid: Uuid) -> Result<Vec<Value>, String> {
        let communities = self
            .repo
            .owned_communities(user_uuid)
            .await
            .map_err(|e| e.to_string())?;
        let ids: Vec<Uuid> = communities.iter().map(|c| c.community_id).collect();
        let counts = self
            .repo
            .member_counts(&ids)
            .await
            .map_err(|e| e.to_string())?;
        let items: Vec<Value> = communities
            .into_iter()
            .map(|c| {
                json!({
                    "communityId": c.community_id,
                    "name": c.name,
                    "slug": c.slug,
                    "memberCount": counts.get(&c.community_id).copied().unwrap_or(0),
                    "role": "Owner",
                    "avatarUuid": c.avatar_uuid,
                    "isPrivate": c.is_private,
                })
            })
            .collect();
        Ok(items)
    }

    pub async fn search(
        &self,
        user_uuid: Uuid,
        query: &str,
        skip: i32,
        take: i32,
    ) -> Result<Vec<Value>, String> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let take = take.clamp(1, 50);
        let skip = skip.max(0);
        let lower = query.to_lowercase();

        let communities = self
            .repo
            .search_communities(user_uuid, &lower, skip, take)
            .await
            .map_err(|e| e.to_string())?;
        if communities.is_empty() {
            return Ok(Vec::new());
        }

        let ids: Vec<Uuid> = communities.iter().map(|c| c.community_id).collect();
        let counts = self
            .repo
            .member_counts(&ids)
            .await
            .map_err(|e| e.to_string())?;
        let roles = self
            .repo
            .user_roles_in_communities(user_uuid, &ids)
            .await
            .map_err(|e| e.to_string())?;

        let items: Vec<Value> = communities
            .into_iter()
            .map(|c| {
                json!({
                    "communityId": c.community_id,
                    "name": c.name,
                    "slug": c.slug,
                    "memberCount": counts.get(&c.community_id).copied().unwrap_or(0),
                    "avatarUuid": c.avatar_uuid,
                    "role": roles
                        .get(&c.community_id)
                        .map(|s| json!(s))
                        .unwrap_or(Value::Null),
                })
            })
            .collect();
        Ok(items)
    }

    pub async fn by_slug(
        &self,
        slug: &str,
        viewer: Option<Uuid>,
    ) -> Result<Result<Value, CommunityError>, String> {
        let normalized = normalize_for_compare(Some(slug));
        if normalized.is_empty() {
            return Ok(Err(CommunityError::BadRequest(
                "Укажите ссылку сообщества.",
            )));
        }
        let Some(community) = self
            .repo
            .community_by_slug(&normalized)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(Err(CommunityError::NotFound));
        };

        let member_count = self
            .repo
            .member_count(community.community_id)
            .await
            .map_err(|e| e.to_string())?;

        if community.is_private {
            let Some(viewer) = viewer else {
                return Ok(Err(CommunityError::NotFound));
            };
            let Some(role) = self
                .repo
                .user_role_in_community(viewer, community.community_id)
                .await
                .map_err(|e| e.to_string())?
            else {
                return Ok(Err(CommunityError::NotFound));
            };
            return Ok(Ok(json!({
                "communityId": community.community_id,
                "name": community.name,
                "slug": community.slug,
                "memberCount": member_count,
                "role": role,
                "avatarUuid": community.avatar_uuid,
                "isPrivate": if role == "Owner" { Value::Bool(community.is_private) } else { Value::Null },
            })));
        }

        let role = if let Some(viewer) = viewer {
            self.repo
                .user_role_in_community(viewer, community.community_id)
                .await
                .map_err(|e| e.to_string())?
        } else {
            None
        };

        Ok(Ok(json!({
            "communityId": community.community_id,
            "name": community.name,
            "slug": community.slug,
            "memberCount": member_count,
            "role": role,
            "avatarUuid": community.avatar_uuid,
            "isPrivate": if role.as_deref() == Some("Owner") { Value::Bool(community.is_private) } else { Value::Null },
        })))
    }

    pub async fn profile_communities(
        &self,
        username: &str,
    ) -> Result<Result<Vec<Value>, CommunityError>, String> {
        let normalized = normalize_slug(Some(username), 50);
        if normalized.is_empty() {
            return Ok(Err(CommunityError::BadRequest("Укажите юзернейм.")));
        }
        let Some(user_uuid) = self.accounts.find_uuid_by_username(&normalized).await? else {
            return Ok(Err(CommunityError::UserNotFound));
        };

        let list = self
            .repo
            .profile_public_member_communities(user_uuid)
            .await
            .map_err(|e| e.to_string())?;
        let items: Vec<Value> = list
            .into_iter()
            .map(|c| {
                json!({
                    "name": c.name,
                    "slug": c.slug,
                })
            })
            .collect();
        Ok(Ok(items))
    }

    pub async fn join(
        &self,
        user_uuid: Uuid,
        community_id: Uuid,
    ) -> Result<Result<Value, CommunityError>, String> {
        let Some(community) = self
            .repo
            .community_by_id(community_id)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(Err(CommunityError::NotFound));
        };
        if community.is_private {
            return Ok(Err(CommunityError::BadRequest(
                "Нельзя подписаться на приватное сообщество.",
            )));
        }
        if self
            .repo
            .is_community_member(community_id, user_uuid)
            .await
            .map_err(|e| e.to_string())?
        {
            return Ok(Err(CommunityError::AlreadyMember));
        }

        self.repo
            .insert_membership(user_uuid, community_id, "Member", Utc::now())
            .await
            .map_err(|e| e.to_string())?;
        self.feed.invalidate(user_uuid);
        self.recommendations.invalidate(user_uuid);

        let member_count = self
            .repo
            .member_count(community_id)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Ok(json!({
            "communityId": community_id,
            "name": community.name,
            "slug": community.slug,
            "memberCount": member_count,
            "role": "Member",
        })))
    }

    pub async fn leave(
        &self,
        user_uuid: Uuid,
        community_id: Uuid,
    ) -> Result<Result<Option<Value>, CommunityError>, String> {
        let Some(link) = self
            .repo
            .membership(user_uuid, community_id)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(Ok(Some(json!({ "message": "Подписки не было." }))));
        };
        if link.role == "Owner" {
            return Ok(Err(CommunityError::OwnerCannotLeave));
        }
        self.repo
            .remove_membership(user_uuid, community_id)
            .await
            .map_err(|e| e.to_string())?;
        self.feed.invalidate(user_uuid);
        self.recommendations.invalidate(user_uuid);
        Ok(Ok(None))
    }

    pub async fn community_posts(
        &self,
        community_id: Uuid,
        viewer: Option<Uuid>,
        skip: i32,
        take: i32,
    ) -> Result<Result<Vec<Value>, CommunityError>, String> {
        let Some(meta) = self
            .repo
            .community_meta(community_id)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(Err(CommunityError::NotFound));
        };
        if meta.is_private {
            let member = match viewer {
                Some(v) => self
                    .repo
                    .is_community_member(community_id, v)
                    .await
                    .map_err(|e| e.to_string())?,
                None => false,
            };
            if !member {
                return Ok(Err(CommunityError::PrivateCommunity));
            }
        }

        let take = take.clamp(1, 50);
        let skip = skip.max(0);
        let posts = self
            .repo
            .community_posts(community_id, skip, take)
            .await
            .map_err(|e| e.to_string())?;
        if posts.is_empty() {
            return Ok(Ok(Vec::new()));
        }
        let items = self.serialize.serialize_post_cards(viewer, &posts).await?;
        Ok(Ok(items))
    }

    pub async fn create(
        &self,
        user_uuid: Uuid,
        name: Option<&str>,
        slug: Option<&str>,
        is_private: Option<bool>,
    ) -> Result<Result<Value, CommunityError>, String> {
        let name = name.unwrap_or("").trim();
        if name.is_empty() {
            return Ok(Err(CommunityError::BadRequest(
                "Укажите название сообщества.",
            )));
        }
        if name.chars().count() > 100 {
            return Ok(Err(CommunityError::BadRequest(
                "Название не более 100 символов.",
            )));
        }

        if slug.is_some()
            && slug.map(str::trim).is_some_and(|s| !s.is_empty())
            && !has_only_slug_chars(slug)
        {
            return Ok(Err(CommunityError::BadRequest(SLUG_FORMAT_MESSAGE)));
        }

        let slug_source = slug
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(name);
        let normalized_slug = normalize_for_compare(Some(slug_source));
        if normalized_slug.is_empty() {
            return Ok(Err(CommunityError::BadRequest(
                "Ссылка не может быть пустой. Используйте латиницу, цифры, дефис или подчёркивание.",
            )));
        }
        if normalized_slug.chars().count() > 100 {
            return Ok(Err(CommunityError::BadRequest(
                "Ссылка не более 100 символов.",
            )));
        }
        if self
            .repo
            .slug_exists(&normalized_slug)
            .await
            .map_err(|e| e.to_string())?
        {
            return Ok(Err(CommunityError::SlugTaken));
        }
        if is_reserved(&normalized_slug) {
            return Ok(Err(CommunityError::SlugReserved));
        }

        let community_id = new_uuid();
        let is_private = is_private.unwrap_or(true);
        let now = Utc::now();
        self.repo
            .insert_community(community_id, name, &normalized_slug, is_private, now)
            .await
            .map_err(|e| e.to_string())?;
        self.repo
            .insert_membership(user_uuid, community_id, "Owner", now)
            .await
            .map_err(|e| e.to_string())?;

        Ok(Ok(json!({
            "communityId": community_id,
            "name": name,
            "slug": normalized_slug,
            "memberCount": 1,
            "isPrivate": is_private,
        })))
    }

    pub async fn update(
        &self,
        user_uuid: Uuid,
        community_id: Uuid,
        name: Option<&str>,
        slug: Option<&str>,
        is_private: Option<bool>,
    ) -> Result<Result<Value, CommunityError>, String> {
        let is_owner = self
            .repo
            .is_community_owner(community_id, user_uuid)
            .await
            .map_err(|e| e.to_string())?;
        if !is_owner {
            return Ok(Err(CommunityError::NotFoundEdit));
        }
        let Some(mut community) = self
            .repo
            .community_by_id(community_id)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(Err(CommunityError::NotFound));
        };

        if let Some(name) = name.filter(|n| !n.trim().is_empty()) {
            let name = name.trim();
            if name.chars().count() > 100 {
                return Ok(Err(CommunityError::BadRequest(
                    "Название не более 100 символов.",
                )));
            }
            community.name = name.to_string();
        }

        if let Some(raw_slug) = slug {
            if !raw_slug.trim().is_empty() && !has_only_slug_chars(Some(raw_slug)) {
                return Ok(Err(CommunityError::BadRequest(SLUG_FORMAT_MESSAGE)));
            }
            let slug_source = if raw_slug.trim().is_empty() {
                community.name.as_str()
            } else {
                raw_slug
            };
            let normalized_slug = normalize_for_compare(Some(slug_source));
            if normalized_slug.is_empty() {
                return Ok(Err(CommunityError::BadRequest(
                    "Ссылка не может быть пустой. Используйте латиницу, цифры, дефис или подчёркивание.",
                )));
            }
            if normalized_slug.chars().count() > 100 {
                return Ok(Err(CommunityError::BadRequest(
                    "Ссылка не более 100 символов.",
                )));
            }
            if normalized_slug != community.slug {
                if self
                    .repo
                    .slug_exists(&normalized_slug)
                    .await
                    .map_err(|e| e.to_string())?
                {
                    return Ok(Err(CommunityError::SlugTaken));
                }
                if is_reserved(&normalized_slug) {
                    return Ok(Err(CommunityError::SlugReserved));
                }
                community.slug = normalized_slug;
            }
        }

        if let Some(is_private) = is_private {
            community.is_private = is_private;
        }

        self.repo
            .update_community(
                community_id,
                &community.name,
                &community.slug,
                community.is_private,
            )
            .await
            .map_err(|e| e.to_string())?;

        let member_count = self
            .repo
            .member_count(community_id)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Ok(json!({
            "communityId": community.community_id,
            "name": community.name,
            "slug": community.slug,
            "memberCount": member_count,
            "isPrivate": community.is_private,
            "avatarUuid": community.avatar_uuid,
        })))
    }

    /// Загрузка аватара сообщества — паритет `UploadCommunityAvatar`.
    pub async fn upload_avatar(
        &self,
        user_uuid: Uuid,
        community_id: Uuid,
        file: CommunityAvatarUpload,
    ) -> Result<Result<Value, UploadCommunityAvatarError>, String> {
        let is_owner = self
            .repo
            .is_community_owner(community_id, user_uuid)
            .await
            .map_err(|e| e.to_string())?;
        if !is_owner {
            return Ok(Err(UploadCommunityAvatarError::Forbidden));
        }
        if file.bytes.is_empty() {
            return Ok(Err(UploadCommunityAvatarError::NoFile));
        }
        if file.bytes.len() > MAX_COMMUNITY_AVATAR_BYTES {
            return Ok(Err(UploadCommunityAvatarError::FileTooLarge));
        }
        let content_type = file
            .content_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if !ALLOWED_COMMUNITY_AVATAR_TYPES
            .iter()
            .any(|t| t.eq_ignore_ascii_case(&content_type))
        {
            return Ok(Err(UploadCommunityAvatarError::BadType));
        }
        if self
            .repo
            .community_by_id(community_id)
            .await
            .map_err(|e| e.to_string())?
            .is_none()
        {
            return Ok(Err(UploadCommunityAvatarError::NotFound));
        }
        let (data, stored_content_type) = match process_avatar_image(&file.bytes) {
            Ok(v) => v,
            Err(PostImageProcessError::TooManyPixels)
            | Err(PostImageProcessError::InvalidFormat) => {
                return Ok(Err(UploadCommunityAvatarError::Unreadable));
            }
        };
        let avatar_uuid = new_uuid();
        let now = Utc::now();
        self.repo
            .insert_community_avatar(avatar_uuid, community_id, stored_content_type, &data, now)
            .await
            .map_err(|e| e.to_string())?;
        self.repo
            .set_community_avatar_uuid(community_id, avatar_uuid)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Ok(json!({ "avatarUuid": avatar_uuid.to_string() })))
    }

    pub async fn delete(
        &self,
        user_uuid: Uuid,
        community_id: Uuid,
    ) -> Result<Result<(), CommunityError>, String> {
        let is_owner = self
            .repo
            .is_community_owner(community_id, user_uuid)
            .await
            .map_err(|e| e.to_string())?;
        if !is_owner {
            return Ok(Err(CommunityError::NotFoundDelete));
        }
        if self
            .repo
            .community_by_id(community_id)
            .await
            .map_err(|e| e.to_string())?
            .is_none()
        {
            return Ok(Err(CommunityError::NotFound));
        }
        let now = Utc::now();
        self.repo
            .purge_community(community_id, now)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Ok(()))
    }

    async fn serialize_community_list(
        &self,
        communities: &[CommunityRow],
        role: Option<&str>,
        include_is_private: bool,
    ) -> Result<Vec<Value>, String> {
        let ids: Vec<Uuid> = communities.iter().map(|c| c.community_id).collect();
        let counts = self
            .repo
            .member_counts(&ids)
            .await
            .map_err(|e| e.to_string())?;
        Ok(communities
            .iter()
            .map(|c| {
                let mut obj = json!({
                    "communityId": c.community_id,
                    "name": c.name,
                    "slug": c.slug,
                    "memberCount": counts.get(&c.community_id).copied().unwrap_or(0),
                    "avatarUuid": c.avatar_uuid,
                });
                if let Some(role) = role {
                    obj["role"] = json!(role);
                }
                if include_is_private {
                    obj["isPrivate"] = json!(c.is_private);
                }
                obj
            })
            .collect())
    }
}
