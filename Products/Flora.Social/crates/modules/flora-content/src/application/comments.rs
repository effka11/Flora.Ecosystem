//! Комментарии к посту — паритет `GetComments` / `GetCommentReplies` / `CreateComment` / `DeleteComment`.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::Utc;
use flora_auth_contracts::AccountDirectory;
use flora_notifications_contracts::{CreateUserNotificationCommand, UserNotificationDispatcher};
use flora_shared::flora_uuid::new_uuid;
use flora_users_contracts::{FeedAuthorProfiles, ProfileAccess, ProfileAccessField};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::application::feed::FeedService;
use crate::application::post_access::PostAccessService;
use crate::application::posts::resolve_actor_presentation;
use crate::application::time::format_utc;
use crate::infrastructure::repo::{CommentRow, ContentRepo};

pub const MAX_COMMENT_CONTENT_LENGTH: usize = 1000;

pub struct CommentsService {
    repo: Arc<ContentRepo>,
    access: Arc<PostAccessService>,
    accounts: Arc<dyn AccountDirectory>,
    profiles: Arc<dyn FeedAuthorProfiles>,
    profile_access: Arc<dyn ProfileAccess>,
    feed: Arc<FeedService>,
    notifications: Arc<dyn UserNotificationDispatcher>,
}

impl CommentsService {
    pub fn new(
        repo: Arc<ContentRepo>,
        access: Arc<PostAccessService>,
        accounts: Arc<dyn AccountDirectory>,
        profiles: Arc<dyn FeedAuthorProfiles>,
        profile_access: Arc<dyn ProfileAccess>,
        feed: Arc<FeedService>,
        notifications: Arc<dyn UserNotificationDispatcher>,
    ) -> Self {
        Self {
            repo,
            access,
            accounts,
            profiles,
            profile_access,
            feed,
            notifications,
        }
    }

    pub async fn create(
        &self,
        author: Uuid,
        post_uuid: Uuid,
        content: &str,
        parent_comment_uuid: Option<Uuid>,
    ) -> Result<Result<Value, CreateCommentError>, String> {
        let Some(post_author) = self
            .repo
            .post_author_uuid(post_uuid)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(Err(CreateCommentError::PostNotFound));
        };

        if !self
            .profile_access
            .can_access(Some(author), post_author, ProfileAccessField::Comments)
            .await?
        {
            return Ok(Err(CreateCommentError::CommentsForbidden));
        }

        let content = content.trim();
        if content.is_empty() {
            return Ok(Err(CreateCommentError::EmptyContent));
        }
        if content.chars().count() > MAX_COMMENT_CONTENT_LENGTH {
            return Ok(Err(CreateCommentError::TooLong));
        }

        let parent_comment_uuid = match parent_comment_uuid {
            None => None,
            Some(uuid) if uuid.is_nil() => return Ok(Err(CreateCommentError::InvalidParent)),
            Some(uuid) => {
                let Some(parent_parent) = self
                    .repo
                    .comment_parent_uuid(post_uuid, uuid)
                    .await
                    .map_err(|e| e.to_string())?
                else {
                    return Ok(Err(CreateCommentError::ParentNotFound));
                };
                if parent_parent.is_some() {
                    return Ok(Err(CreateCommentError::ParentNotRoot));
                }
                Some(uuid)
            }
        };

        let comment_uuid = new_uuid();
        let created_at = Utc::now();
        self.repo
            .insert_comment(
                comment_uuid,
                post_uuid,
                author,
                content,
                parent_comment_uuid,
                created_at,
            )
            .await
            .map_err(|e| e.to_string())?;

        self.feed.invalidate(author);
        self.try_notify_comment(
            author,
            post_uuid,
            post_author,
            comment_uuid,
            parent_comment_uuid,
        )
        .await;

        let username = self
            .accounts
            .usernames_by_uuids(&[author])
            .await?
            .into_iter()
            .next()
            .map(|(_, name)| name)
            .unwrap_or_default();
        let display = self
            .profiles
            .by_uuids(&[author])
            .await?
            .into_iter()
            .next()
            .map(|p| {
                if p.display_name.is_empty() {
                    username.clone()
                } else {
                    p.display_name
                }
            })
            .unwrap_or_else(|| username.clone());

        Ok(Ok(json!({
            "commentUuid": comment_uuid,
            "authorUsername": username,
            "authorDisplayName": display,
            "content": content,
            "createdAt": format_utc(created_at),
            "repliesCount": 0,
            "replies": [],
        })))
    }

    pub async fn delete(
        &self,
        author: Uuid,
        post_uuid: Uuid,
        comment_uuid: Uuid,
    ) -> Result<Result<(), DeleteCommentError>, String> {
        let Some(row) = self
            .repo
            .comment_for_delete(post_uuid, comment_uuid)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(Err(DeleteCommentError::NotFound));
        };
        if row.author_user_uuid != author {
            return Ok(Err(DeleteCommentError::Forbidden));
        }
        if !row.is_deleted {
            self.repo
                .soft_delete_comment(comment_uuid, Utc::now())
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(Ok(()))
    }

    pub async fn list_roots(
        &self,
        post_uuid: Uuid,
        viewer: Option<Uuid>,
        skip: i32,
        take: i32,
        include_replies: bool,
    ) -> Result<Result<Vec<Value>, CommentsError>, String> {
        if !self.access.can_view(post_uuid, viewer).await? {
            return Ok(Err(CommentsError::PostNotFound));
        }

        let take = take.clamp(1, 100);
        let skip = skip.max(0);
        let all = self
            .repo
            .comments_by_post(post_uuid)
            .await
            .map_err(|e| e.to_string())?;

        let roots: Vec<&CommentRow> = all
            .iter()
            .filter(|c| c.parent_comment_uuid.is_none())
            .skip(skip as usize)
            .take(take as usize)
            .collect();

        let list = self.map_nodes(&all, &roots, include_replies).await?;
        Ok(Ok(list))
    }

    pub async fn list_replies(
        &self,
        post_uuid: Uuid,
        comment_uuid: Uuid,
        viewer: Option<Uuid>,
    ) -> Result<Result<Vec<Value>, CommentsError>, String> {
        if !self.access.can_view(post_uuid, viewer).await? {
            return Ok(Err(CommentsError::PostNotFound));
        }

        if !self
            .repo
            .comment_exists(post_uuid, comment_uuid)
            .await
            .map_err(|e| e.to_string())?
        {
            return Ok(Err(CommentsError::CommentNotFound));
        }

        let all = self
            .repo
            .comments_by_post(post_uuid)
            .await
            .map_err(|e| e.to_string())?;

        let direct: Vec<&CommentRow> = all
            .iter()
            .filter(|c| c.parent_comment_uuid == Some(comment_uuid))
            .collect();

        let list = self.map_nodes(&all, &direct, false).await?;
        Ok(Ok(list))
    }

    async fn map_nodes(
        &self,
        all: &[CommentRow],
        nodes: &[&CommentRow],
        include_replies: bool,
    ) -> Result<Vec<Value>, String> {
        let author_ids: Vec<Uuid> = all
            .iter()
            .map(|c| c.author_user_uuid)
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();

        let usernames = self
            .accounts
            .usernames_by_uuids(&author_ids)
            .await?
            .into_iter()
            .collect::<HashMap<_, _>>();

        let profiles = self
            .profiles
            .by_uuids(&author_ids)
            .await?
            .into_iter()
            .map(|p| (p.user_uuid, p))
            .collect::<HashMap<_, _>>();

        let map_reply = |c: &CommentRow| -> Value {
            let username = usernames
                .get(&c.author_user_uuid)
                .cloned()
                .unwrap_or_default();
            let display = profiles
                .get(&c.author_user_uuid)
                .map(|pr| {
                    if pr.display_name.is_empty() {
                        username.clone()
                    } else {
                        pr.display_name.clone()
                    }
                })
                .unwrap_or_else(|| username.clone());

            json!({
                "commentUuid": c.comment_uuid,
                "authorUsername": username,
                "authorDisplayName": display,
                "content": c.content,
                "createdAt": format_utc(c.created_at),
                "repliesCount": 0,
                "replies": [],
            })
        };

        let mut out = Vec::with_capacity(nodes.len());
        for c in nodes {
            let direct_replies: Vec<&CommentRow> = all
                .iter()
                .filter(|r| r.parent_comment_uuid == Some(c.comment_uuid))
                .collect();

            let username = usernames
                .get(&c.author_user_uuid)
                .cloned()
                .unwrap_or_default();
            let display = profiles
                .get(&c.author_user_uuid)
                .map(|pr| {
                    if pr.display_name.is_empty() {
                        username.clone()
                    } else {
                        pr.display_name.clone()
                    }
                })
                .unwrap_or_else(|| username.clone());

            let replies: Vec<Value> = if include_replies {
                direct_replies.iter().map(|r| map_reply(r)).collect()
            } else {
                Vec::new()
            };

            out.push(json!({
                "commentUuid": c.comment_uuid,
                "authorUsername": username,
                "authorDisplayName": display,
                "content": c.content,
                "createdAt": format_utc(c.created_at),
                "repliesCount": direct_replies.len(),
                "replies": replies,
            }));
        }

        Ok(out)
    }

    /// Паритет `TryNotifyCommentAsync` — ошибки только в лог.
    async fn try_notify_comment(
        &self,
        actor_user_uuid: Uuid,
        post_uuid: Uuid,
        post_author: Uuid,
        comment_uuid: Uuid,
        parent_comment_uuid: Option<Uuid>,
    ) {
        if let Err(e) = self
            .notify_comment(
                actor_user_uuid,
                post_uuid,
                post_author,
                comment_uuid,
                parent_comment_uuid,
            )
            .await
        {
            tracing::warn!(
                error = %e,
                post = %post_uuid,
                "Не удалось создать уведомление о комментарии к посту"
            );
        }
    }

    async fn notify_comment(
        &self,
        actor_user_uuid: Uuid,
        post_uuid: Uuid,
        post_author: Uuid,
        comment_uuid: Uuid,
        parent_comment_uuid: Option<Uuid>,
    ) -> Result<(), String> {
        let (label, _) =
            resolve_actor_presentation(&*self.accounts, &*self.profiles, actor_user_uuid).await;

        let mut recipients = std::collections::HashSet::new();
        if post_author != actor_user_uuid {
            recipients.insert(post_author);
        }
        if let Some(parent_uuid) = parent_comment_uuid
            && let Some(parent_author) = self
                .repo
                .comment_author_uuid(parent_uuid)
                .await
                .map_err(|e| e.to_string())?
            && parent_author != actor_user_uuid
        {
            recipients.insert(parent_author);
        }

        let text = if parent_comment_uuid.is_some() {
            format!("{label} ответил(а) в обсуждении")
        } else {
            format!("{label} прокомментировал(а) ваш пост")
        };

        for recipient in recipients {
            self.notifications
                .dispatch(CreateUserNotificationCommand {
                    recipient_user_uuid: recipient,
                    actor_user_uuid: Some(actor_user_uuid),
                    notification_type: "reply".into(),
                    category: "social".into(),
                    text: text.clone(),
                    post_uuid: Some(post_uuid),
                    comment_uuid: Some(comment_uuid),
                })
                .await?;
        }
        Ok(())
    }
}

pub enum CommentsError {
    PostNotFound,
    CommentNotFound,
}

pub enum CreateCommentError {
    PostNotFound,
    CommentsForbidden,
    EmptyContent,
    TooLong,
    InvalidParent,
    ParentNotFound,
    ParentNotRoot,
}

pub enum DeleteCommentError {
    NotFound,
    Forbidden,
}
