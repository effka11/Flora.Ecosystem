//! Публичная отдача bytea-медиа (post images, avatars, videos).

use std::sync::Arc;

use flora_users_contracts::UserAvatarMedia;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::infrastructure::repo::{ContentRepo, MediaBlob, VideoLite};

pub struct MediaService {
    repo: Arc<ContentRepo>,
    user_avatars: Arc<dyn UserAvatarMedia>,
}

impl MediaService {
    pub fn new(repo: Arc<ContentRepo>, user_avatars: Arc<dyn UserAvatarMedia>) -> Self {
        Self { repo, user_avatars }
    }

    pub async fn post_image(&self, uuid: Uuid) -> Result<Option<MediaBlob>, String> {
        self.repo
            .post_image_by_uuid(uuid)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn avatar(&self, uuid: Uuid) -> Result<Option<MediaBlob>, String> {
        if let Some(blob) = self.user_avatars.by_uuid(uuid).await? {
            return Ok(Some(MediaBlob {
                data: blob.data,
                content_type: blob.content_type,
            }));
        }
        self.repo
            .community_avatar_by_uuid(uuid)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn post_video(&self, uuid: Uuid) -> Result<Option<MediaBlob>, String> {
        self.repo
            .post_video_by_uuid(uuid)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn post_video_poster(&self, uuid: Uuid) -> Result<Option<MediaBlob>, String> {
        self.repo
            .post_video_poster_by_uuid(uuid)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn post_video_status(&self, post_uuid: Uuid) -> Result<Option<Value>, String> {
        let row = self
            .repo
            .video_status_by_post(post_uuid)
            .await
            .map_err(|e| e.to_string())?;
        Ok(row.map(video_status_json))
    }
}

pub fn video_status_json(v: VideoLite) -> Value {
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
}
