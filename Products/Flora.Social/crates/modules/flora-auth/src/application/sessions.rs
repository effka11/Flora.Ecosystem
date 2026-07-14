use std::sync::Arc;

use uuid::Uuid;

use crate::http::{SessionListItem, format_utc};
use crate::infrastructure::repo::AuthRepo;

pub struct SessionService {
    repo: Arc<AuthRepo>,
}

impl SessionService {
    pub fn new(repo: Arc<AuthRepo>) -> Self {
        Self { repo }
    }

    pub async fn list_active(
        &self,
        user_uuid: Uuid,
        current_jti: &str,
    ) -> Result<Vec<SessionListItem>, sqlx::Error> {
        let now = chrono::Utc::now();
        let rows = self.repo.list_active_sessions(user_uuid, now).await?;
        Ok(rows
            .into_iter()
            .map(|s| SessionListItem {
                session_id: s.session_id,
                created_at: format_utc(s.created_at),
                last_activity: format_utc(s.last_activity),
                ip_address: s.ip_address,
                city: s.city,
                country_code: s.country_code,
                is_current: !current_jti.is_empty() && s.jwt_id == current_jti,
            })
            .collect())
    }
}
