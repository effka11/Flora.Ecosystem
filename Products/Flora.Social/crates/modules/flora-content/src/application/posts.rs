//! Создание постов и взаимодействия — паритет `CreatePost`, `LikePost`, `UnlikePost`, `DeletePost`.

use std::sync::Arc;

use chrono::Utc;
use flora_auth_contracts::AccountDirectory;
use flora_notifications_contracts::{CreateUserNotificationCommand, UserNotificationDispatcher};
use flora_shared::flora_uuid::new_uuid;
use flora_users_contracts::FeedAuthorProfiles;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::application::feed::FeedService;
use crate::application::time::format_utc;
use crate::infrastructure::repo::ContentRepo;

pub const MAX_POST_CONTENT_LENGTH: usize = 2000;

pub struct PostService {
    repo: Arc<ContentRepo>,
    feed: Arc<FeedService>,
    accounts: Arc<dyn AccountDirectory>,
    profiles: Arc<dyn FeedAuthorProfiles>,
    notifications: Arc<dyn UserNotificationDispatcher>,
}

impl PostService {
    pub fn new(
        repo: Arc<ContentRepo>,
        feed: Arc<FeedService>,
        accounts: Arc<dyn AccountDirectory>,
        profiles: Arc<dyn FeedAuthorProfiles>,
        notifications: Arc<dyn UserNotificationDispatcher>,
    ) -> Self {
        Self {
            repo,
            feed,
            accounts,
            profiles,
            notifications,
        }
    }

    pub async fn create(
        &self,
        author: Uuid,
        content: &str,
        community_id: Option<Uuid>,
    ) -> Result<Result<Value, CreatePostError>, String> {
        let content = content.trim();
        if content.chars().count() > MAX_POST_CONTENT_LENGTH {
            return Ok(Err(CreatePostError::TooLong));
        }
        if let Some(cid) = community_id {
            let is_owner = self
                .repo
                .is_community_owner(cid, author)
                .await
                .map_err(|e| e.to_string())?;
            if !is_owner {
                return Ok(Err(CreatePostError::Forbidden));
            }
        }
        let post_uuid = new_uuid();
        let created_at = Utc::now();
        self.repo
            .insert_post(post_uuid, author, content, community_id, created_at)
            .await
            .map_err(|e| e.to_string())?;
        self.feed.invalidate(author);
        Ok(Ok(json!({
            "postUuid": post_uuid,
            "content": content,
            "createdAt": format_utc(created_at),
        })))
    }

    pub async fn like(
        &self,
        user_uuid: Uuid,
        post_uuid: Uuid,
    ) -> Result<Result<Value, PostActionError>, String> {
        if !self
            .repo
            .post_exists(post_uuid)
            .await
            .map_err(|e| e.to_string())?
        {
            return Ok(Err(PostActionError::NotFound));
        }
        let already = self
            .repo
            .has_liked(post_uuid, user_uuid)
            .await
            .map_err(|e| e.to_string())?;
        if !already {
            self.repo
                .insert_like(post_uuid, user_uuid, Utc::now())
                .await
                .map_err(|e| e.to_string())?;
            self.feed.invalidate(user_uuid);
            self.try_notify_like(user_uuid, post_uuid).await;
        }
        let count = self
            .repo
            .like_count(post_uuid)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Ok(json!({
            "liked": true,
            "likesCount": count,
        })))
    }

    pub async fn unlike(&self, user_uuid: Uuid, post_uuid: Uuid) -> Result<Value, String> {
        let like = self
            .repo
            .has_liked(post_uuid, user_uuid)
            .await
            .map_err(|e| e.to_string())?;
        if like {
            self.repo
                .delete_like(post_uuid, user_uuid)
                .await
                .map_err(|e| e.to_string())?;
            self.feed.invalidate(user_uuid);
        }
        let count = self
            .repo
            .like_count(post_uuid)
            .await
            .map_err(|e| e.to_string())?;
        Ok(json!({
            "liked": false,
            "likesCount": count,
        }))
    }

    pub async fn repost(
        &self,
        user_uuid: Uuid,
        post_uuid: Uuid,
    ) -> Result<Result<Value, PostActionError>, String> {
        if !self
            .repo
            .post_exists(post_uuid)
            .await
            .map_err(|e| e.to_string())?
        {
            return Ok(Err(PostActionError::NotFound));
        }
        let already = self
            .repo
            .has_reposted(post_uuid, user_uuid)
            .await
            .map_err(|e| e.to_string())?;
        if !already {
            self.repo
                .insert_repost(post_uuid, user_uuid, Utc::now())
                .await
                .map_err(|e| e.to_string())?;
            self.feed.invalidate(user_uuid);
        }
        let count = self
            .repo
            .repost_count(post_uuid)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Ok(json!({
            "reposted": true,
            "repostsCount": count,
        })))
    }

    pub async fn unrepost(&self, user_uuid: Uuid, post_uuid: Uuid) -> Result<Value, String> {
        let exists = self
            .repo
            .has_reposted(post_uuid, user_uuid)
            .await
            .map_err(|e| e.to_string())?;
        if exists {
            self.repo
                .delete_repost(post_uuid, user_uuid)
                .await
                .map_err(|e| e.to_string())?;
            self.feed.invalidate(user_uuid);
        }
        let count = self
            .repo
            .repost_count(post_uuid)
            .await
            .map_err(|e| e.to_string())?;
        Ok(json!({
            "reposted": false,
            "repostsCount": count,
        }))
    }

    pub async fn record_view(
        &self,
        user_uuid: Uuid,
        post_uuid: Uuid,
    ) -> Result<Result<Value, PostActionError>, String> {
        if !self
            .repo
            .post_exists(post_uuid)
            .await
            .map_err(|e| e.to_string())?
        {
            return Ok(Err(PostActionError::NotFound));
        }
        let already = self
            .repo
            .has_viewed(post_uuid, user_uuid)
            .await
            .map_err(|e| e.to_string())?;
        if !already {
            self.repo
                .insert_view(post_uuid, user_uuid, Utc::now())
                .await
                .map_err(|e| e.to_string())?;
        }
        let count = self
            .repo
            .view_count(post_uuid)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Ok(json!({ "viewsCount": count })))
    }

    pub async fn delete(
        &self,
        user_uuid: Uuid,
        post_uuid: Uuid,
    ) -> Result<Result<(), DeletePostError>, String> {
        let Some((author, is_deleted)) = self
            .repo
            .post_for_delete(post_uuid)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(Err(DeletePostError::NotFound));
        };
        if author != user_uuid {
            return Ok(Err(DeletePostError::Forbidden));
        }
        if is_deleted {
            return Ok(Ok(()));
        }
        self.repo
            .soft_delete_post(post_uuid, Utc::now())
            .await
            .map_err(|e| e.to_string())?;
        self.feed.invalidate(user_uuid);
        Ok(Ok(()))
    }

    /// Паритет `TryNotifyLikeAsync` — ошибки только в лог.
    async fn try_notify_like(&self, actor_user_uuid: Uuid, post_uuid: Uuid) {
        if let Err(e) = self.notify_like(actor_user_uuid, post_uuid).await {
            tracing::warn!(
                error = %e,
                post = %post_uuid,
                "Не удалось создать уведомление о лайке поста"
            );
        }
    }

    async fn notify_like(&self, actor_user_uuid: Uuid, post_uuid: Uuid) -> Result<(), String> {
        let Some(author) = self
            .repo
            .post_author_uuid(post_uuid)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(());
        };
        if author == actor_user_uuid {
            return Ok(());
        }
        let (label, _) =
            resolve_actor_presentation(&*self.accounts, &*self.profiles, actor_user_uuid).await;
        self.notifications
            .dispatch(CreateUserNotificationCommand {
                recipient_user_uuid: author,
                actor_user_uuid: Some(actor_user_uuid),
                notification_type: "like".into(),
                category: "social".into(),
                text: format!("{label} оценил ваш пост"),
                post_uuid: Some(post_uuid),
                comment_uuid: None,
            })
            .await
    }
}

/// Паритет `ResolveActorPresentationAsync` (label, username).
pub(crate) async fn resolve_actor_presentation(
    accounts: &dyn AccountDirectory,
    profiles: &dyn FeedAuthorProfiles,
    actor_user_uuid: Uuid,
) -> (String, String) {
    let username = match accounts.get_public(actor_user_uuid).await {
        Ok(Some(a)) => a.username,
        _ => String::new(),
    };
    let display_name = match profiles.by_uuids(&[actor_user_uuid]).await {
        Ok(rows) => rows
            .into_iter()
            .next()
            .map(|p| p.display_name.trim().to_string())
            .filter(|s| !s.is_empty()),
        Err(_) => None,
    };
    let label = if let Some(d) = display_name {
        d
    } else if !username.is_empty() {
        format!("@{username}")
    } else {
        "Пользователь".into()
    };
    (label, username)
}

pub enum CreatePostError {
    TooLong,
    Forbidden,
}

pub enum PostActionError {
    NotFound,
}

pub enum DeletePostError {
    NotFound,
    Forbidden,
}
