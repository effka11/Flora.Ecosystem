//! Посты профиля — паритет `GetPosts` / `GetLikedPosts` / `GetRepostedPosts`.

use std::sync::Arc;

use flora_auth_contracts::AccountDirectory;
use flora_users_contracts::{ProfileAccess, ProfileAccessField};
use uuid::Uuid;

use crate::application::serialize::FeedSerializer;
use crate::infrastructure::repo::{ContentRepo, ProfilePostRow};

pub struct ProfilePostsService {
    repo: Arc<ContentRepo>,
    accounts: Arc<dyn AccountDirectory>,
    access: Arc<dyn ProfileAccess>,
    serialize: Arc<FeedSerializer>,
}

impl ProfilePostsService {
    pub fn new(
        repo: Arc<ContentRepo>,
        accounts: Arc<dyn AccountDirectory>,
        access: Arc<dyn ProfileAccess>,
        serialize: Arc<FeedSerializer>,
    ) -> Self {
        Self {
            repo,
            accounts,
            access,
            serialize,
        }
    }

    pub async fn posts_by_username(
        &self,
        username: &str,
        viewer: Option<Uuid>,
        skip: i32,
        take: i32,
    ) -> Result<ProfilePostsOutcome, String> {
        let normalized = flora_shared::latin_identifiers::normalize_username(Some(username), 50);
        if normalized.is_empty() {
            return Ok(ProfilePostsOutcome::BadUsername);
        }
        let Some(owner_uuid) = self.accounts.find_uuid_by_username(&normalized).await? else {
            return Ok(ProfilePostsOutcome::NotFound);
        };
        if !self
            .access
            .can_access(viewer, owner_uuid, ProfileAccessField::Posts)
            .await?
        {
            return Ok(ProfilePostsOutcome::Posts(Vec::new()));
        }
        let take = i64::from(take.clamp(1, 50));
        let skip = i64::from(skip.max(0));
        let posts = self
            .repo
            .profile_posts_by_author(owner_uuid, skip, take)
            .await
            .map_err(|e| e.to_string())?;
        Ok(ProfilePostsOutcome::Posts(posts))
    }

    pub async fn liked_by_username(
        &self,
        username: &str,
        viewer: Option<Uuid>,
        skip: i32,
        take: i32,
    ) -> Result<ProfilePostsOutcome, String> {
        self.by_interaction(
            username,
            viewer,
            skip,
            take,
            ProfileAccessField::Likes,
            true,
        )
        .await
    }

    pub async fn reposted_by_username(
        &self,
        username: &str,
        viewer: Option<Uuid>,
        skip: i32,
        take: i32,
    ) -> Result<ProfilePostsOutcome, String> {
        self.by_interaction(
            username,
            viewer,
            skip,
            take,
            ProfileAccessField::Reposts,
            false,
        )
        .await
    }

    async fn by_interaction(
        &self,
        username: &str,
        viewer: Option<Uuid>,
        skip: i32,
        take: i32,
        field: ProfileAccessField,
        liked: bool,
    ) -> Result<ProfilePostsOutcome, String> {
        let normalized = flora_shared::latin_identifiers::normalize_username(Some(username), 50);
        if normalized.is_empty() {
            return Ok(ProfilePostsOutcome::NotFound);
        }
        let Some(owner_uuid) = self.accounts.find_uuid_by_username(&normalized).await? else {
            return Ok(ProfilePostsOutcome::NotFound);
        };
        if !self.access.can_access(viewer, owner_uuid, field).await? {
            return Ok(ProfilePostsOutcome::Posts(Vec::new()));
        }
        let take = i64::from(take.clamp(1, 50));
        let skip = i64::from(skip.max(0));
        let posts = if liked {
            self.repo
                .profile_liked_posts(owner_uuid, skip, take)
                .await
                .map_err(|e| e.to_string())?
        } else {
            self.repo
                .profile_reposted_posts(owner_uuid, skip, take)
                .await
                .map_err(|e| e.to_string())?
        };
        Ok(ProfilePostsOutcome::Posts(posts))
    }

    pub async fn serialize(
        &self,
        posts: Vec<ProfilePostRow>,
        viewer: Option<Uuid>,
    ) -> Result<serde_json::Value, String> {
        self.serialize.serialize_profile_posts(posts, viewer).await
    }
}

pub enum ProfilePostsOutcome {
    BadUsername,
    NotFound,
    Posts(Vec<ProfilePostRow>),
}
