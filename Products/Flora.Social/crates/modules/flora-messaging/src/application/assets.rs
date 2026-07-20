//! Opaque message media assets (image/voice/video bytea).

use std::sync::Arc;

use flora_auth_contracts::AccountDirectory;
use flora_messaging_contracts::{
    UploadImageAssetResultDto, UploadVideoAssetResultDto, UploadVoiceAssetResultDto,
};
use flora_users_contracts::MessagesAccess;
use sqlx::PgPool;
use uuid::Uuid;

use crate::infrastructure::{
    ImageAssetRow, VideoAssetRow, VoiceAssetRow, fetch_image_asset, fetch_video_asset,
    fetch_voice_asset, insert_image_asset, insert_video_asset, insert_voice_asset,
    is_message_participant, normalize_content_type,
};

pub const MAX_MESSAGE_IMAGE_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_MESSAGE_VIDEO_BYTES: usize = 36 * 1024 * 1024;
pub const MAX_VOICE_ASSET_BYTES: usize = 14 * 1024 * 1024;
pub const MAX_VOICE_ASSET_DURATION_MS: i32 = 30 * 60 * 1000;

#[derive(Debug, Clone)]
pub enum AssetError {
    BadRequest(String),
    NotFound(String),
    Forbidden,
    Internal(String),
}

pub struct AssetBlob {
    pub bytes: Vec<u8>,
    pub content_type: String,
    pub duration_ms: Option<i32>,
}

pub struct AssetService {
    pool: PgPool,
    accounts: Arc<dyn AccountDirectory>,
    messages_access: Arc<dyn MessagesAccess>,
}

impl AssetService {
    pub fn new(
        pool: PgPool,
        accounts: Arc<dyn AccountDirectory>,
        messages_access: Arc<dyn MessagesAccess>,
    ) -> Self {
        Self {
            pool,
            accounts,
            messages_access,
        }
    }

    pub async fn upload_image(
        &self,
        sender_uuid: Uuid,
        to_user_uuid: Uuid,
        content_type: Option<&str>,
        file_content_type: Option<&str>,
        bytes: &[u8],
    ) -> Result<UploadImageAssetResultDto, AssetError> {
        validate_peer(
            sender_uuid,
            to_user_uuid,
            bytes.len(),
            MAX_MESSAGE_IMAGE_BYTES,
        )?;
        if bytes.is_empty() {
            return Err(AssetError::BadRequest("Файл фото пуст.".into()));
        }
        self.ensure_receiver_exists(to_user_uuid).await?;
        self.ensure_can_send(sender_uuid, to_user_uuid).await?;

        let stored_ct = normalize_content_type(content_type, file_content_type);
        let asset_uuid = Uuid::now_v7();
        insert_image_asset(
            &self.pool,
            asset_uuid,
            sender_uuid,
            to_user_uuid,
            &stored_ct,
            bytes,
        )
        .await
        .map_err(AssetError::Internal)?;

        Ok(UploadImageAssetResultDto {
            image_asset_uuid: asset_uuid,
            content_type: stored_ct,
        })
    }

    pub async fn upload_voice(
        &self,
        sender_uuid: Uuid,
        to_user_uuid: Uuid,
        duration_ms: i32,
        file_content_type: Option<&str>,
        bytes: &[u8],
    ) -> Result<UploadVoiceAssetResultDto, AssetError> {
        validate_peer(
            sender_uuid,
            to_user_uuid,
            bytes.len(),
            MAX_VOICE_ASSET_BYTES,
        )?;
        if duration_ms <= 0 || duration_ms > MAX_VOICE_ASSET_DURATION_MS {
            return Err(AssetError::BadRequest(
                "Недопустимая длительность голосового сообщения.".into(),
            ));
        }
        if bytes.is_empty() {
            return Err(AssetError::BadRequest(
                "Файл голосового сообщения пуст.".into(),
            ));
        }
        self.ensure_receiver_exists(to_user_uuid).await?;
        self.ensure_can_send(sender_uuid, to_user_uuid).await?;

        let stored_ct = normalize_content_type(None, file_content_type);
        let asset_uuid = Uuid::now_v7();
        insert_voice_asset(
            &self.pool,
            asset_uuid,
            sender_uuid,
            to_user_uuid,
            &stored_ct,
            duration_ms,
            bytes,
        )
        .await
        .map_err(AssetError::Internal)?;

        Ok(UploadVoiceAssetResultDto {
            voice_asset_uuid: asset_uuid,
            content_type: stored_ct,
            duration_ms,
        })
    }

    pub async fn upload_video(
        &self,
        sender_uuid: Uuid,
        to_user_uuid: Uuid,
        duration_ms: i32,
        content_type: Option<&str>,
        file_content_type: Option<&str>,
        bytes: &[u8],
    ) -> Result<UploadVideoAssetResultDto, AssetError> {
        validate_peer(
            sender_uuid,
            to_user_uuid,
            bytes.len(),
            MAX_MESSAGE_VIDEO_BYTES,
        )?;
        if bytes.is_empty() {
            return Err(AssetError::BadRequest("Файл видео пуст.".into()));
        }
        self.ensure_receiver_exists(to_user_uuid).await?;
        self.ensure_can_send(sender_uuid, to_user_uuid).await?;

        let stored_ct = normalize_content_type(content_type, file_content_type);
        let asset_uuid = Uuid::now_v7();
        insert_video_asset(
            &self.pool,
            asset_uuid,
            sender_uuid,
            to_user_uuid,
            &stored_ct,
            duration_ms.max(0),
            bytes,
        )
        .await
        .map_err(AssetError::Internal)?;

        Ok(UploadVideoAssetResultDto {
            video_asset_uuid: asset_uuid,
            content_type: stored_ct,
        })
    }

    pub async fn get_image(
        &self,
        user_uuid: Uuid,
        asset_uuid: Uuid,
    ) -> Result<AssetBlob, AssetError> {
        let Some(asset) = fetch_image_asset(&self.pool, asset_uuid)
            .await
            .map_err(AssetError::Internal)?
        else {
            return Err(AssetError::NotFound("Фото не найдено.".into()));
        };
        if !peer_can_read(&self.pool, user_uuid, &asset).await? {
            return Err(AssetError::Forbidden);
        }
        Ok(AssetBlob {
            bytes: asset.encrypted_bytes,
            content_type: asset.content_type,
            duration_ms: None,
        })
    }

    pub async fn get_voice(
        &self,
        user_uuid: Uuid,
        asset_uuid: Uuid,
    ) -> Result<AssetBlob, AssetError> {
        let Some(asset) = fetch_voice_asset(&self.pool, asset_uuid)
            .await
            .map_err(AssetError::Internal)?
        else {
            return Err(AssetError::NotFound(
                "Голосовое сообщение не найдено.".into(),
            ));
        };
        if !peer_can_read(&self.pool, user_uuid, &asset).await? {
            return Err(AssetError::Forbidden);
        }
        Ok(AssetBlob {
            bytes: asset.encrypted_bytes,
            content_type: asset.content_type,
            duration_ms: Some(asset.duration_ms),
        })
    }

    pub async fn get_video(
        &self,
        user_uuid: Uuid,
        asset_uuid: Uuid,
    ) -> Result<AssetBlob, AssetError> {
        let Some(asset) = fetch_video_asset(&self.pool, asset_uuid)
            .await
            .map_err(AssetError::Internal)?
        else {
            return Err(AssetError::NotFound("Видео не найдено.".into()));
        };
        if !sender_or_message_can_read(&self.pool, user_uuid, &asset).await? {
            return Err(AssetError::Forbidden);
        }
        Ok(AssetBlob {
            bytes: asset.encrypted_bytes,
            content_type: asset.content_type,
            duration_ms: None,
        })
    }

    async fn ensure_receiver_exists(&self, receiver_uuid: Uuid) -> Result<(), AssetError> {
        let exists = self
            .accounts
            .get_public(receiver_uuid)
            .await
            .map_err(AssetError::Internal)?;
        if exists.is_none() {
            return Err(AssetError::NotFound("Пользователь не найден.".into()));
        }
        Ok(())
    }

    async fn ensure_can_send(
        &self,
        sender_uuid: Uuid,
        receiver_uuid: Uuid,
    ) -> Result<(), AssetError> {
        let allowed = self
            .messages_access
            .can_send_messages(sender_uuid, receiver_uuid)
            .await
            .map_err(AssetError::Internal)?;
        if !allowed {
            return Err(AssetError::Forbidden);
        }
        Ok(())
    }
}

trait AssetAccess {
    fn sender_user_uuid(&self) -> Uuid;
    fn receiver_user_uuid(&self) -> Uuid;
    fn message_uuid(&self) -> Option<Uuid>;
}

impl AssetAccess for ImageAssetRow {
    fn sender_user_uuid(&self) -> Uuid {
        self.sender_user_uuid
    }
    fn receiver_user_uuid(&self) -> Uuid {
        self.receiver_user_uuid
    }
    fn message_uuid(&self) -> Option<Uuid> {
        self.message_uuid
    }
}

impl AssetAccess for VoiceAssetRow {
    fn sender_user_uuid(&self) -> Uuid {
        self.sender_user_uuid
    }
    fn receiver_user_uuid(&self) -> Uuid {
        self.receiver_user_uuid
    }
    fn message_uuid(&self) -> Option<Uuid> {
        self.message_uuid
    }
}

impl AssetAccess for VideoAssetRow {
    fn sender_user_uuid(&self) -> Uuid {
        self.sender_user_uuid
    }
    fn receiver_user_uuid(&self) -> Uuid {
        self.receiver_user_uuid
    }
    fn message_uuid(&self) -> Option<Uuid> {
        self.message_uuid
    }
}

async fn peer_can_read(
    pool: &PgPool,
    user_uuid: Uuid,
    asset: &impl AssetAccess,
) -> Result<bool, AssetError> {
    let mut can_read =
        asset.sender_user_uuid() == user_uuid || asset.receiver_user_uuid() == user_uuid;
    if !can_read && let Some(msg) = asset.message_uuid() {
        can_read = is_message_participant(pool, msg, user_uuid)
            .await
            .map_err(AssetError::Internal)?;
    }
    Ok(can_read)
}

async fn sender_or_message_can_read(
    pool: &PgPool,
    user_uuid: Uuid,
    asset: &impl AssetAccess,
) -> Result<bool, AssetError> {
    let mut can_read = asset.sender_user_uuid() == user_uuid;
    if !can_read && let Some(msg) = asset.message_uuid() {
        can_read = is_message_participant(pool, msg, user_uuid)
            .await
            .map_err(AssetError::Internal)?;
    }
    Ok(can_read)
}

fn validate_peer(
    sender_uuid: Uuid,
    to_user_uuid: Uuid,
    len: usize,
    max_bytes: usize,
) -> Result<(), AssetError> {
    if to_user_uuid == sender_uuid {
        let msg = if max_bytes == MAX_MESSAGE_IMAGE_BYTES {
            "Нельзя отправить фото себе."
        } else if max_bytes == MAX_VOICE_ASSET_BYTES {
            "Нельзя отправить голосовое себе."
        } else {
            "Нельзя отправить видео себе."
        };
        return Err(AssetError::BadRequest(msg.into()));
    }
    if len > max_bytes {
        let msg = if max_bytes == MAX_MESSAGE_IMAGE_BYTES {
            "Фото слишком большое."
        } else if max_bytes == MAX_VOICE_ASSET_BYTES {
            "Голосовое сообщение слишком большое."
        } else {
            "Видео слишком большое."
        };
        return Err(AssetError::BadRequest(msg.into()));
    }
    Ok(())
}
