//! Черновики постов — паритет `ListPostDrafts`, `CreatePostDraft`, `UpdatePostDraft`, `DeletePostDraft`.

use std::sync::Arc;

use chrono::Utc;
use flora_shared::flora_uuid::new_uuid;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::application::posts::MAX_POST_CONTENT_LENGTH;
use crate::application::time::format_utc;
use crate::infrastructure::repo::{ContentRepo, PostDraftRow};

pub const MAX_POST_DRAFTS_PER_USER: i64 = 15;
pub const MAX_POST_DRAFT_LABEL_LEN: usize = 50;

pub struct DraftsService {
    repo: Arc<ContentRepo>,
}

impl DraftsService {
    pub fn new(repo: Arc<ContentRepo>) -> Self {
        Self { repo }
    }

    pub async fn list(
        &self,
        author: Uuid,
        community_id: Option<Uuid>,
    ) -> Result<Vec<Value>, String> {
        let rows = self
            .repo
            .list_post_drafts(author, community_id)
            .await
            .map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(draft_json).collect())
    }

    pub async fn create(
        &self,
        author: Uuid,
        label: Option<&str>,
        content: &str,
        community_id: Option<Uuid>,
    ) -> Result<Result<Value, CreateDraftError>, String> {
        if content.chars().count() > MAX_POST_CONTENT_LENGTH {
            return Ok(Err(CreateDraftError::TooLong));
        }
        if let Some(cid) = community_id {
            let is_owner = self
                .repo
                .is_community_owner(cid, author)
                .await
                .map_err(|e| e.to_string())?;
            if !is_owner {
                return Ok(Err(CreateDraftError::Forbidden));
            }
        }
        let count = self
            .repo
            .count_post_drafts_in_scope(author, community_id)
            .await
            .map_err(|e| e.to_string())?;
        if count >= MAX_POST_DRAFTS_PER_USER {
            return Ok(Err(CreateDraftError::TooMany));
        }
        let label = normalize_post_draft_label(label, (count + 1) as usize);
        let draft_uuid = new_uuid();
        let now = Utc::now();
        self.repo
            .insert_post_draft(
                draft_uuid,
                author,
                community_id,
                &label,
                content,
                now,
                now,
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(Ok(draft_json(PostDraftRow {
            draft_uuid,
            label,
            content: content.to_string(),
            community_id,
            created_at: now,
            updated_at: now,
        })))
    }

    pub async fn update(
        &self,
        author: Uuid,
        draft_uuid: Uuid,
        label: Option<&str>,
        content: Option<&str>,
    ) -> Result<Result<Value, UpdateDraftError>, String> {
        let Some(mut draft) = self
            .repo
            .get_post_draft(draft_uuid)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(Err(UpdateDraftError::NotFound));
        };
        if draft.author_user_uuid != author {
            return Ok(Err(UpdateDraftError::Forbidden));
        }
        if let Some(raw_label) = label {
            let trimmed = raw_label.trim();
            if trimmed.is_empty() {
                return Ok(Err(UpdateDraftError::EmptyLabel));
            }
            draft.label = if trimmed.chars().count() <= MAX_POST_DRAFT_LABEL_LEN {
                trimmed.to_string()
            } else {
                trimmed.chars().take(MAX_POST_DRAFT_LABEL_LEN).collect()
            };
        }
        if let Some(raw_content) = content {
            if raw_content.chars().count() > MAX_POST_CONTENT_LENGTH {
                return Ok(Err(UpdateDraftError::TooLong));
            }
            draft.content = raw_content.to_string();
        }
        draft.updated_at = Utc::now();
        self.repo
            .update_post_draft(
                draft_uuid,
                &draft.label,
                &draft.content,
                draft.updated_at,
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(Ok(draft_json(PostDraftRow {
            draft_uuid: draft.draft_uuid,
            label: draft.label,
            content: draft.content,
            community_id: draft.community_id,
            created_at: draft.created_at,
            updated_at: draft.updated_at,
        })))
    }

    pub async fn delete(
        &self,
        author: Uuid,
        draft_uuid: Uuid,
    ) -> Result<Result<(), DeleteDraftError>, String> {
        let Some(draft) = self
            .repo
            .get_post_draft(draft_uuid)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(Err(DeleteDraftError::NotFound));
        };
        if draft.author_user_uuid != author {
            return Ok(Err(DeleteDraftError::Forbidden));
        }
        self.repo
            .delete_post_draft(draft_uuid)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Ok(()))
    }
}

fn draft_json(row: PostDraftRow) -> Value {
    json!({
        "draftUuid": row.draft_uuid,
        "label": row.label,
        "content": row.content,
        "communityId": row.community_id,
        "createdAt": format_utc(row.created_at),
        "updatedAt": format_utc(row.updated_at),
    })
}

fn normalize_post_draft_label(label: Option<&str>, fallback_index: usize) -> String {
    let trimmed = label.unwrap_or("").trim();
    if trimmed.is_empty() {
        return format!("Черновик {fallback_index}");
    }
    if trimmed.chars().count() <= MAX_POST_DRAFT_LABEL_LEN {
        trimmed.to_string()
    } else {
        trimmed.chars().take(MAX_POST_DRAFT_LABEL_LEN).collect()
    }
}

pub enum CreateDraftError {
    TooLong,
    Forbidden,
    TooMany,
}

pub enum UpdateDraftError {
    NotFound,
    Forbidden,
    EmptyLabel,
    TooLong,
}

pub enum DeleteDraftError {
    NotFound,
    Forbidden,
}
