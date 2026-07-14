use std::sync::Arc;

use uuid::Uuid;

use crate::http::SecurityStatusResponse;
use crate::infrastructure::repo::AuthRepo;

pub struct SecurityService {
    repo: Arc<AuthRepo>,
}

impl SecurityService {
    pub fn new(repo: Arc<AuthRepo>) -> Self {
        Self { repo }
    }

    pub async fn status(&self, user_uuid: Uuid) -> Result<SecurityStatusResponse, sqlx::Error> {
        Ok(match self.repo.get_security_status(user_uuid).await? {
            Some(row) => SecurityStatusResponse {
                two_factor_enabled: row.two_factor_enabled,
                email_verified: row.email_verified,
                phone_verified: row.phone_verified,
            },
            None => SecurityStatusResponse {
                two_factor_enabled: false,
                email_verified: false,
                phone_verified: false,
            },
        })
    }
}
