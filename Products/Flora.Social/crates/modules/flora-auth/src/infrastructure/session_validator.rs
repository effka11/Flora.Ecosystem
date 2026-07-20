//! Адаптер `AuthRepo` → `AccessSessionValidator`.

use std::sync::Arc;

use chrono::Utc;
use flora_auth_contracts::{AccessSessionValidator, BoxFuture};
use uuid::Uuid;

use crate::infrastructure::repo::AuthRepo;

pub struct SqlAccessSessionValidator {
    repo: Arc<AuthRepo>,
}

impl SqlAccessSessionValidator {
    pub fn new(repo: Arc<AuthRepo>) -> Self {
        Self { repo }
    }
}

impl AccessSessionValidator for SqlAccessSessionValidator {
    fn is_active(&self, user_uuid: Uuid, jwt_id: &str) -> BoxFuture<'_, Result<bool, String>> {
        let jwt_id = jwt_id.to_string();
        Box::pin(async move {
            self.repo
                .is_active_session(user_uuid, &jwt_id, Utc::now())
                .await
                .map_err(|error| error.to_string())
        })
    }
}

pub fn as_validator(repo: Arc<AuthRepo>) -> Arc<dyn AccessSessionValidator> {
    Arc::new(SqlAccessSessionValidator::new(repo))
}
