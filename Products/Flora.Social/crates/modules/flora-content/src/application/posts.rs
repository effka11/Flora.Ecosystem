//! Создание постов и взаимодействия — паритет `CreatePost`, `LikePost`, `UnlikePost`, `DeletePost`.

use std::sync::Arc;

use chrono::Utc;
use flora_auth_contracts::AccountDirectory;
use flora_notifications_contracts::{
    SocialActivityCommand, SocialActivityKind, UserNotificationDispatcher,
};
use flora_shared::flora_uuid::new_uuid;
use flora_users_contracts::FeedAuthorProfiles;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::application::feed::FeedService;
use crate::application::post_access::PostAccessService;
use crate::application::time::format_utc;
use crate::infrastructure::repo::ContentRepo;

pub const MAX_POST_CONTENT_LENGTH: usize = 2000;

pub struct PostService {
    repo: Arc<ContentRepo>,
    feed: Arc<FeedService>,
    accounts: Arc<dyn AccountDirectory>,
    profiles: Arc<dyn FeedAuthorProfiles>,
    access: Arc<PostAccessService>,
    notifications: Arc<dyn UserNotificationDispatcher>,
}

impl PostService {
    pub fn new(
        repo: Arc<ContentRepo>,
        feed: Arc<FeedService>,
        accounts: Arc<dyn AccountDirectory>,
        profiles: Arc<dyn FeedAuthorProfiles>,
        access: Arc<PostAccessService>,
        notifications: Arc<dyn UserNotificationDispatcher>,
    ) -> Self {
        Self {
            repo,
            feed,
            accounts,
            profiles,
            access,
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
        if !self.access.can_view(post_uuid, Some(user_uuid)).await? {
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
        if !self.access.can_view(post_uuid, Some(user_uuid)).await? {
            return Ok(json!({ "liked": false, "likesCount": 0 }));
        }
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
            self.try_retract_like(user_uuid, post_uuid).await;
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
        if !self.access.can_view(post_uuid, Some(user_uuid)).await? {
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
            self.try_notify_repost(user_uuid, post_uuid).await;
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
        if !self.access.can_view(post_uuid, Some(user_uuid)).await? {
            return Ok(json!({ "reposted": false, "repostsCount": 0 }));
        }
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
            self.try_retract_repost(user_uuid, post_uuid).await;
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
        if !self.access.can_view(post_uuid, Some(user_uuid)).await? {
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

    /// Ошибки retract только в лог (как try_notify_like).
    async fn try_retract_like(&self, actor_user_uuid: Uuid, post_uuid: Uuid) {
        if let Err(e) = self.retract_like(actor_user_uuid, post_uuid).await {
            tracing::warn!(
                error = %e,
                post = %post_uuid,
                "Не удалось отозвать уведомление о лайке поста"
            );
        }
    }

    async fn retract_like(&self, actor_user_uuid: Uuid, post_uuid: Uuid) -> Result<(), String> {
        let Some(mut command) = self
            .social_activity_command(
                actor_user_uuid,
                post_uuid,
                SocialActivityKind::Like { post_uuid },
            )
            .await?
        else {
            return Ok(());
        };
        // After DELETE like: always sync Notifications; partial when actor still likes author posts.
        let still = self
            .repo
            .actor_likes_any_post_by_author(actor_user_uuid, command.recipient_user_uuid)
            .await
            .map_err(|e| e.to_string())?;
        let (call_retract, partial) = plan_like_unlike_retract(still);
        debug_assert!(call_retract);
        command.partial = partial;
        self.notifications.retract_social(command).await
    }

    async fn try_notify_repost(&self, actor_user_uuid: Uuid, post_uuid: Uuid) {
        if let Err(e) = self.notify_repost(actor_user_uuid, post_uuid).await {
            tracing::warn!(
                error = %e,
                post = %post_uuid,
                "Не удалось создать уведомление о репосте"
            );
        }
    }

    async fn notify_repost(&self, actor_user_uuid: Uuid, post_uuid: Uuid) -> Result<(), String> {
        let Some(command) = self
            .social_activity_command(
                actor_user_uuid,
                post_uuid,
                SocialActivityKind::Repost { post_uuid },
            )
            .await?
        else {
            return Ok(());
        };
        self.notifications.apply_social(command).await
    }

    async fn try_retract_repost(&self, actor_user_uuid: Uuid, post_uuid: Uuid) {
        if let Err(e) = self.retract_repost(actor_user_uuid, post_uuid).await {
            tracing::warn!(
                error = %e,
                post = %post_uuid,
                "Не удалось отозвать уведомление о репосте"
            );
        }
    }

    async fn retract_repost(&self, actor_user_uuid: Uuid, post_uuid: Uuid) -> Result<(), String> {
        let Some(command) = self
            .social_activity_command(
                actor_user_uuid,
                post_uuid,
                SocialActivityKind::Repost { post_uuid },
            )
            .await?
        else {
            return Ok(());
        };
        let still = self
            .repo
            .actor_reposts_any_post_by_author(actor_user_uuid, command.recipient_user_uuid)
            .await
            .map_err(|e| e.to_string())?;
        if !should_retract_social_after_remove(still) {
            return Ok(());
        }
        self.notifications.retract_social(command).await
    }

    /// Resolve author + actor_label; `None` when post missing or self-action.
    async fn social_activity_command(
        &self,
        actor_user_uuid: Uuid,
        post_uuid: Uuid,
        kind: SocialActivityKind,
    ) -> Result<Option<SocialActivityCommand>, String> {
        let Some(author) = self
            .repo
            .post_author_uuid(post_uuid)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(None);
        };
        if author == actor_user_uuid {
            return Ok(None);
        }
        let (label, _) =
            resolve_actor_presentation(&*self.accounts, &*self.profiles, actor_user_uuid).await;
        Ok(Some(SocialActivityCommand {
            recipient_user_uuid: author,
            actor_user_uuid,
            actor_label: label,
            kind,
            partial: false,
        }))
    }

    async fn notify_like(&self, actor_user_uuid: Uuid, post_uuid: Uuid) -> Result<(), String> {
        let Some(command) = self
            .social_activity_command(
                actor_user_uuid,
                post_uuid,
                SocialActivityKind::Like { post_uuid },
            )
            .await?
        else {
            return Ok(());
        };
        self.notifications.apply_social(command).await
    }
}

/// Unlike always notifies Notifications. Returns `(call_retract, partial)`.
pub(crate) fn plan_like_unlike_retract(still_has_likes_on_author: bool) -> (bool, bool) {
    (true, still_has_likes_on_author)
}

/// After removing one repost: call Notifications retract only when none remain.
pub(crate) fn should_retract_social_after_remove(still_has_activity_on_author: bool) -> bool {
    !still_has_activity_on_author
}

/// Паритет `ResolveActorPresentationAsync` (label, username).
/// Local to Content — Users has its own follow-notification presentation helper.
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

#[cfg(test)]
mod tests {
    use super::{plan_like_unlike_retract, should_retract_social_after_remove};

    #[test]
    fn unlike_not_last_always_calls_retract_with_partial_true() {
        let (call, partial) = plan_like_unlike_retract(true);
        assert!(call);
        assert!(partial);
    }

    #[test]
    fn unlike_last_always_calls_retract_with_partial_false() {
        let (call, partial) = plan_like_unlike_retract(false);
        assert!(call);
        assert!(!partial);
    }

    #[test]
    fn unrepost_not_last_does_not_retract() {
        // Repost still gates: only full remove calls Notifications.
        assert!(!should_retract_social_after_remove(true));
    }

    #[test]
    fn last_repost_retracts() {
        assert!(should_retract_social_after_remove(false));
    }
}
