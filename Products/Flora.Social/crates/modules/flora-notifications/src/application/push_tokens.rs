//! Push token register/unregister — паритет `PushTokenService` + controller validation.

use std::sync::Arc;

use uuid::Uuid;

use crate::infrastructure::PushTokenRepo;

pub struct PushTokenService {
    repo: Arc<PushTokenRepo>,
}

impl PushTokenService {
    pub fn new(repo: Arc<PushTokenRepo>) -> Self {
        Self { repo }
    }

    pub async fn register(
        &self,
        user_uuid: Uuid,
        token: &str,
        platform: Option<&str>,
    ) -> Result<(), String> {
        let normalized = token.trim();
        if normalized.is_empty() {
            return Ok(());
        }
        let plat = normalize_platform(platform);
        self.repo.register(user_uuid, normalized, &plat).await
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

    pub async fn tokens_for_user_platform(
        &self,
        user_uuid: Uuid,
        platform: &str,
    ) -> Result<Vec<String>, String> {
        self.repo.tokens_for_user_platform(user_uuid, platform).await
    }

    pub async fn list_user_uuids_by_platform(&self, platform: &str) -> Result<Vec<Uuid>, String> {
        self.repo.list_user_uuids_by_platform(platform).await
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
