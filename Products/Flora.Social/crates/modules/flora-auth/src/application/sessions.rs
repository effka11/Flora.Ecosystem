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

    /// Завершить все сессии, кроме текущей. Ответ: число отозванных.
    pub async fn revoke_others(
        &self,
        user_uuid: Uuid,
        current_jti: &str,
    ) -> Result<u64, sqlx::Error> {
        let now = chrono::Utc::now();
        self.repo
            .revoke_other_sessions(user_uuid, current_jti, now)
            .await
    }

    /// Logout текущей сессии по `jti`. Пустой `jti` — no-op (как в C#).
    pub async fn logout_current(&self, jti: &str) -> Result<(), sqlx::Error> {
        if jti.is_empty() {
            return Ok(());
        }
        self.repo.revoke_by_jwt_id(jti).await?;
        Ok(())
    }
}
