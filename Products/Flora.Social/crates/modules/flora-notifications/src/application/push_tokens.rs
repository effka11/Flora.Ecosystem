//! Push token register/unregister — паритет `PushTokenService` + controller validation.

use std::sync::Arc;

use base64::Engine as _;
use flora_messaging_contracts::{BoxFuture, PushPreviewTarget, PushPreviewTargetProvider};
use uuid::Uuid;

use crate::infrastructure::{PushTokenRecord, PushTokenRepo};

pub struct SecurePreviewRegistration<'a> {
    pub installation_uuid: Uuid,
    pub protocol_version: i32,
    pub preview_key_id: Uuid,
    pub public_key_base64_url: &'a str,
}

pub struct PushTokenService {
    repo: Arc<PushTokenRepo>,
    secure_preview_android_enabled: bool,
    secure_preview_ios_enabled: bool,
}

impl PushTokenService {
    pub fn new(
        repo: Arc<PushTokenRepo>,
        secure_preview_android_enabled: bool,
        secure_preview_ios_enabled: bool,
    ) -> Self {
        Self {
            repo,
            secure_preview_android_enabled,
            secure_preview_ios_enabled,
        }
    }

    pub async fn register(
        &self,
        user_uuid: Uuid,
        token: &str,
        platform: Option<&str>,
        provider: Option<&str>,
        secure_preview: Option<SecurePreviewRegistration<'_>>,
    ) -> Result<(), String> {
        let normalized = token.trim();
        if normalized.is_empty() {
            return Ok(());
        }
        let plat = normalize_platform(platform);
        let normalized_provider = normalize_provider(provider, &plat);
        if let Some(preview) = secure_preview.as_ref() {
            if preview.protocol_version != 1 {
                return Err("Неподдерживаемая версия secure push preview.".into());
            }
            let key = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(preview.public_key_base64_url)
                .map_err(|_| String::from("Некорректный preview public key."))?;
            if key.len() != 32 {
                return Err("Preview public key должен быть 32 байта.".into());
            }
        }
        self.repo
            .register(
                user_uuid,
                normalized,
                &plat,
                &normalized_provider,
                secure_preview.as_ref().map(|p| p.installation_uuid),
                secure_preview.as_ref().map(|p| p.protocol_version),
                secure_preview.as_ref().map(|p| p.preview_key_id),
                secure_preview.as_ref().map(|p| p.public_key_base64_url),
            )
            .await
    }

    pub async fn unregister(&self, user_uuid: Uuid, token: &str) -> Result<(), String> {
        let normalized = token.trim();
        if normalized.is_empty() {
            return Ok(());
        }
        self.repo.unregister(user_uuid, normalized).await
    }

    pub async fn tokens_for_user(&self, user_uuid: Uuid) -> Result<Vec<String>, String> {
        self.repo.tokens_for_user(user_uuid).await
    }

    pub async fn records_for_user(&self, user_uuid: Uuid) -> Result<Vec<PushTokenRecord>, String> {
        self.repo.records_for_user(user_uuid).await
    }

    pub async fn preview_targets(&self, user_uuid: Uuid) -> Result<Vec<PushPreviewTarget>, String> {
        let records = self.repo.records_for_user(user_uuid).await?;
        let mut seen = std::collections::HashSet::new();
        Ok(records
            .into_iter()
            .filter_map(|record| {
                let platform_enabled = match record.platform.as_str() {
                    "ios" => self.secure_preview_ios_enabled,
                    _ => self.secure_preview_android_enabled,
                };
                if !platform_enabled {
                    return None;
                }
                let installation_uuid = record.installation_uuid?;
                let preview_key_id = record.preview_key_id?;
                let public_key_base64_url = record.preview_public_key?;
                let protocol_version = record.secure_preview_version?;
                let key = (installation_uuid, preview_key_id);
                if protocol_version != 1 || !seen.insert(key) {
                    return None;
                }
                Some(PushPreviewTarget {
                    installation_uuid,
                    preview_key_id,
                    public_key_base64_url,
                    protocol_version,
                })
            })
            .take(8)
            .collect())
    }

    pub async fn tokens_for_user_platform(
        &self,
        user_uuid: Uuid,
        platform: &str,
    ) -> Result<Vec<String>, String> {
        self.repo
            .tokens_for_user_platform(user_uuid, platform)
            .await
    }

    pub async fn list_user_uuids_by_platform(&self, platform: &str) -> Result<Vec<Uuid>, String> {
        self.repo.list_user_uuids_by_platform(platform).await
    }
}

impl PushPreviewTargetProvider for PushTokenService {
    fn targets_for(
        &self,
        recipient_user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<Vec<PushPreviewTarget>, String>> {
        Box::pin(async move { self.preview_targets(recipient_user_uuid).await })
    }
}

fn normalize_platform(platform: Option<&str>) -> String {
    let p = platform.unwrap_or("").trim().to_ascii_lowercase();
    if p == "ios" {
        "ios".into()
    } else {
        "android".into()
    }
}

fn normalize_provider(provider: Option<&str>, platform: &str) -> String {
    match provider.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "apns" if platform == "ios" => "apns".into(),
        "fcm" if platform == "android" => "fcm".into(),
        _ if platform == "ios" => "apns".into(),
        _ => "fcm".into(),
    }
}
