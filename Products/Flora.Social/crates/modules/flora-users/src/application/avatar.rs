//! Загрузка/удаление аватара — паритет `UploadAvatar` / `DeleteAvatar`.

use std::sync::Arc;

use flora_shared::flora_uuid::new_uuid;
use sqlx::PgPool;
use uuid::Uuid;

use crate::application::post_image_processor::{PostImageProcessError, process_post_image};
use crate::infrastructure::avatars;

pub const ALLOWED_AVATAR_TYPES: &[&str] = &["image/jpeg", "image/png", "image/webp"];
pub const MAX_AVATAR_SIZE_BYTES: usize = 2 * 1024 * 1024;

pub struct AvatarUploadInput {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

pub enum AvatarUploadError {
    NoFile,
    FileTooLarge,
    BadType,
    Unreadable,
}

pub struct AvatarService {
    pool: PgPool,
}

impl AvatarService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn upload(
        &self,
        user_uuid: Uuid,
        file: AvatarUploadInput,
    ) -> Result<Uuid, AvatarUploadError> {
        if file.bytes.is_empty() {
            return Err(AvatarUploadError::NoFile);
        }
        if file.bytes.len() > MAX_AVATAR_SIZE_BYTES {
            return Err(AvatarUploadError::FileTooLarge);
        }
        let content_type = file
            .content_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if !ALLOWED_AVATAR_TYPES
            .iter()
            .any(|t| t.eq_ignore_ascii_case(&content_type))
        {
            return Err(AvatarUploadError::BadType);
        }
        let (data, stored_content_type) = match process_post_image(&file.bytes) {
            Ok(v) => v,
            Err(PostImageProcessError::TooManyPixels)
            | Err(PostImageProcessError::InvalidFormat) => {
                return Err(AvatarUploadError::Unreadable);
            }
        };

        let avatar_uuid = new_uuid();
        avatars::insert_user_avatar(
            &self.pool,
            avatar_uuid,
            user_uuid,
            stored_content_type,
            &data,
        )
        .await
        .map_err(|_| AvatarUploadError::Unreadable)?;
        avatars::set_profile_avatar_uuid(&self.pool, user_uuid, avatar_uuid)
            .await
            .map_err(|_| AvatarUploadError::Unreadable)?;
        Ok(avatar_uuid)
    }

    pub async fn delete(&self, user_uuid: Uuid) -> Result<(), String> {
        avatars::clear_profile_avatar_uuid(&self.pool, user_uuid).await
    }
}

pub fn avatar_service(pool: PgPool) -> Arc<AvatarService> {
    Arc::new(AvatarService::new(pool))
}
