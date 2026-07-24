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
    fn resolve_active_session(
        &self,
        user_uuid: Uuid,
        jwt_id: &str,
    ) -> BoxFuture<'_, Result<Option<Uuid>, String>> {
        let jwt_id = jwt_id.to_string();
        Box::pin(async move {
            self.repo
                .find_active_session_id_by_jwt(user_uuid, &jwt_id, Utc::now())
                .await
                .map_err(|error| error.to_string())
        })
    }
}

pub fn as_validator(repo: Arc<AuthRepo>) -> Arc<dyn AccessSessionValidator> {
    Arc::new(SqlAccessSessionValidator::new(repo))
}
