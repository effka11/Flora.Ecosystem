//! Загрузка фото к посту — паритет `UploadPostImages`.

use std::sync::Arc;

use flora_shared::flora_uuid::new_uuid;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::application::post_image_processor::{PostImageProcessError, process_post_image};
use crate::infrastructure::repo::ContentRepo;

pub const ALLOWED_POST_IMAGE_TYPES: &[&str] = &["image/jpeg", "image/png", "image/webp"];
pub const MAX_POST_IMAGE_SIZE_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_POST_IMAGES_COUNT: i64 = 10;

pub struct UploadedFile {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

pub struct PostImagesService {
    repo: Arc<ContentRepo>,
}

impl PostImagesService {
    pub fn new(repo: Arc<ContentRepo>) -> Self {
        Self { repo }
    }

    pub async fn upload(
        &self,
        author: Uuid,
        post_uuid: Uuid,
        files: Vec<UploadedFile>,
    ) -> Result<Result<Value, UploadPostImagesError>, String> {
        let Some(post_author) = self
            .repo
            .post_author_uuid(post_uuid)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(Err(UploadPostImagesError::NotFound));
        };
        if post_author != author {
            return Ok(Err(UploadPostImagesError::Forbidden));
        }
        if files.is_empty() {
            return Ok(Err(UploadPostImagesError::NoFiles));
        }
        if files.len() as i64 > MAX_POST_IMAGES_COUNT {
            return Ok(Err(UploadPostImagesError::TooManyFiles));
        }
        let existing_count = self
            .repo
            .count_post_images(post_uuid)
            .await
            .map_err(|e| e.to_string())?;
        if existing_count + files.len() as i64 > MAX_POST_IMAGES_COUNT {
            return Ok(Err(UploadPostImagesError::PostImageCap));
        }

        let mut uploaded = Vec::new();
        for (i, file) in files.into_iter().enumerate() {
            if file.bytes.is_empty() {
                continue;
            }
            if file.bytes.len() > MAX_POST_IMAGE_SIZE_BYTES {
                return Ok(Err(UploadPostImagesError::FileTooLarge));
            }
            let content_type = file
                .content_type
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if !ALLOWED_POST_IMAGE_TYPES
                .iter()
                .any(|t| t.eq_ignore_ascii_case(&content_type))
            {
                return Ok(Err(UploadPostImagesError::BadType));
            }
            let (data, stored_content_type) = match process_post_image(&file.bytes) {
                Ok(v) => v,
                Err(PostImageProcessError::TooManyPixels) | Err(PostImageProcessError::InvalidFormat) => {
                    return Ok(Err(UploadPostImagesError::Unreadable));
                }
            };
            let image_uuid = new_uuid();
            self.repo
                .insert_post_image(
                    image_uuid,
                    post_uuid,
                    stored_content_type,
                    &data,
                    existing_count as i32 + i as i32,
                )
                .await
                .map_err(|e| e.to_string())?;
            uploaded.push(image_uuid);
        }

        Ok(Ok(json!({ "imageUuids": uploaded })))
    }
}

pub enum UploadPostImagesError {
    NotFound,
    Forbidden,
    NoFiles,
    TooManyFiles,
    PostImageCap,
    FileTooLarge,
    BadType,
    Unreadable,
}
