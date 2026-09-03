//! Создание постов и взаимодействия — create / update / like / unlike / delete.

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
use crate::application::feed_search::FeedSearchHost;
use crate::application::post_access::PostAccessService;
use crate::application::post_images::MAX_POST_IMAGES_COUNT;
use crate::application::time::format_utc;
use crate::infrastructure::repo::{ContentRepo, VideoLite};

pub const MAX_POST_CONTENT_LENGTH: usize = 2000;

pub struct PostService {
    repo: Arc<ContentRepo>,
    feed: Arc<FeedService>,
    feed_search: Arc<FeedSearchHost>,
    accounts: Arc<dyn AccountDirectory>,
    profiles: Arc<dyn FeedAuthorProfiles>,
    access: Arc<PostAccessService>,
    notifications: Arc<dyn UserNotificationDispatcher>,
}

impl PostService {
    pub fn new(
        repo: Arc<ContentRepo>,
        feed: Arc<FeedService>,
        feed_search: Arc<FeedSearchHost>,
        accounts: Arc<dyn AccountDirectory>,
        profiles: Arc<dyn FeedAuthorProfiles>,
        access: Arc<PostAccessService>,
        notifications: Arc<dyn UserNotificationDispatcher>,
    ) -> Self {
        Self {
            repo,
            feed,
            feed_search,
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
        self.feed_search
            .on_post_created(post_uuid, author, content, community_id, created_at)
            .await;
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
        self.feed_search.on_post_deleted(post_uuid);
        Ok(Ok(()))
    }

    pub async fn update(
        &self,
        editor: Uuid,
        post_uuid: Uuid,
        content: &str,
        keep_image_uuids: Option<Vec<Uuid>>,
        remove_video: bool,
        expect_added_media: bool,
    ) -> Result<Result<Value, UpdatePostError>, String> {
        let Some(post) = self
            .repo
            .post_for_update(post_uuid)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(Err(UpdatePostError::NotFound));
        };
        if let Err(err) = authorize_post_edit(editor, post.author_user_uuid, post.is_deleted) {
            return Ok(Err(err));
        }

        let current_images = self
            .repo
            .current_image_uuids(post_uuid)
            .await
            .map_err(|e| e.to_string())?;
        let current_video = self
            .repo
            .current_video(post_uuid)
            .await
            .map_err(|e| e.to_string())?;

        let plan = match plan_post_edit(
            &post.content,
            &current_images,
            current_video.as_ref().map(|v| v.video_uuid),
            content,
            keep_image_uuids.as_deref(),
            remove_video,
            expect_added_media,
        ) {
            Ok(plan) => plan,
            Err(err) => return Ok(Err(err)),
        };

        if plan.write_revision {
            self.repo
                .commit_post_edit(
                    post_uuid,
                    editor,
                    &post.content,
                    &current_images,
                    current_video.as_ref().map(|v| v.video_uuid),
                    &plan.content,
                    &plan.keep_image_uuids,
                    plan.remove_video,
                )
                .await
                .map_err(|e| e.to_string())?;
            self.feed.invalidate(editor);
            self.feed_search
                .on_post_created(
                    post_uuid,
                    editor,
                    &plan.content,
                    post.community_id,
                    post.created_at,
                )
                .await;
        }

        let image_uuids = if plan.write_revision {
            plan.keep_image_uuids.clone()
        } else {
            current_images
        };
        let video = if plan.write_revision && plan.remove_video {
            None
        } else if plan.write_revision {
            self.repo
                .current_video(post_uuid)
                .await
                .map_err(|e| e.to_string())?
        } else {
            current_video
        };
        let content = if plan.write_revision {
            plan.content
        } else {
            post.content
        };

        Ok(Ok(update_post_json(
            post_uuid,
            &content,
            post.created_at,
            &image_uuids,
            video.as_ref(),
        )))
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

#[derive(Debug)]
pub enum UpdatePostError {
    NotFound,
    Forbidden,
    TooLong,
    Empty,
    BadImages,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PostEditPlan {
    pub content: String,
    pub keep_image_uuids: Vec<Uuid>,
    pub remove_video: bool,
    pub write_revision: bool,
}

pub(crate) fn authorize_post_edit(
    editor: Uuid,
    author: Uuid,
    is_deleted: bool,
) -> Result<(), UpdatePostError> {
    if is_deleted {
        return Err(UpdatePostError::NotFound);
    }
    if author != editor {
        return Err(UpdatePostError::Forbidden);
    }
    Ok(())
}

pub(crate) fn plan_post_edit(
    current_content: &str,
    current_images: &[Uuid],
    current_video: Option<Uuid>,
    raw_content: &str,
    keep_image_uuids: Option<&[Uuid]>,
    remove_video: bool,
    expect_added_media: bool,
) -> Result<PostEditPlan, UpdatePostError> {
    let content = raw_content.trim().to_string();
    if content.chars().count() > MAX_POST_CONTENT_LENGTH {
        return Err(UpdatePostError::TooLong);
    }

    let keep_image_uuids = match keep_image_uuids {
        None => current_images.to_vec(),
        Some(keep) => {
            let mut out = Vec::with_capacity(keep.len());
            for uuid in keep {
                if !current_images.contains(uuid) {
                    return Err(UpdatePostError::BadImages);
                }
                if !out.contains(uuid) {
                    out.push(*uuid);
                }
            }
            out
        }
    };
    if keep_image_uuids.len() as i64 > MAX_POST_IMAGES_COUNT {
        return Err(UpdatePostError::BadImages);
    }

    let will_have_video = current_video.is_some() && !remove_video;
    if content.is_empty() && keep_image_uuids.is_empty() && !will_have_video && !expect_added_media
    {
        return Err(UpdatePostError::Empty);
    }

    let content_changed = content != current_content;
    let images_changed = keep_image_uuids.as_slice() != current_images;
    let video_changed = remove_video && current_video.is_some();
    let write_revision = expect_added_media || content_changed || images_changed || video_changed;

    Ok(PostEditPlan {
        content,
        keep_image_uuids,
        remove_video,
        write_revision,
    })
}

fn update_post_json(
    post_uuid: Uuid,
    content: &str,
    created_at: chrono::DateTime<chrono::Utc>,
    image_uuids: &[Uuid],
    video: Option<&VideoLite>,
) -> Value {
    json!({
        "postUuid": post_uuid,
        "content": content,
        "createdAt": format_utc(created_at),
        "imageUuids": image_uuids,
        "video": video.map(video_lite_json),
    })
}

fn video_lite_json(video: &VideoLite) -> Value {
    let status = match video.status {
        1 => "ready",
        2 => "failed",
        _ => "processing",
    };
    json!({
        "videoUuid": video.video_uuid,
        "status": status,
        "width": video.width,
        "height": video.height,
        "durationMs": video.duration_ms,
    })
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::{
        UpdatePostError, authorize_post_edit, plan_like_unlike_retract, plan_post_edit,
        should_retract_social_after_remove,
    };

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

    #[test]
    fn edit_acl_rejects_stranger_and_deleted() {
        let author = Uuid::now_v7();
        let editor = Uuid::now_v7();
        assert!(matches!(
            authorize_post_edit(editor, author, false),
            Err(UpdatePostError::Forbidden)
        ));
        assert!(matches!(
            authorize_post_edit(author, author, true),
            Err(UpdatePostError::NotFound)
        ));
        assert!(authorize_post_edit(author, author, false).is_ok());
    }

    #[test]
    fn edit_too_long_is_rejected() {
        let long = "я".repeat(2001);
        let err = plan_post_edit("hi", &[], None, &long, None, false, false).unwrap_err();
        assert!(matches!(err, UpdatePostError::TooLong));
    }

    #[test]
    fn edit_empty_without_media_is_rejected() {
        let err = plan_post_edit("hi", &[], None, "  ", None, false, false).unwrap_err();
        assert!(matches!(err, UpdatePostError::Empty));
    }

    #[test]
    fn edit_empty_allowed_when_expecting_media() {
        let plan = plan_post_edit("hi", &[], None, "", None, false, true).unwrap();
        assert!(plan.write_revision);
        assert!(plan.content.is_empty());
    }

    #[test]
    fn edit_unknown_keep_image_is_rejected() {
        let current = Uuid::now_v7();
        let other = Uuid::now_v7();
        let err =
            plan_post_edit("hi", &[current], None, "hi", Some(&[other]), false, false).unwrap_err();
        assert!(matches!(err, UpdatePostError::BadImages));
    }

    #[test]
    fn identical_edit_is_noop_without_expect_media() {
        let plan = plan_post_edit("hi", &[], None, "hi", None, false, false).unwrap();
        assert!(!plan.write_revision);
    }

    #[test]
    fn content_change_writes_revision() {
        let plan = plan_post_edit("old", &[], None, "new", None, false, false).unwrap();
        assert!(plan.write_revision);
        assert_eq!(plan.content, "new");
    }

    #[test]
    fn update_json_omits_edited_flag() {
        let body = super::update_post_json(Uuid::now_v7(), "hello", chrono::Utc::now(), &[], None);
        assert!(body.get("isEdited").is_none());
        assert!(body.get("editedAt").is_none());
        assert_eq!(body.get("content").and_then(|v| v.as_str()), Some("hello"));
    }
}
