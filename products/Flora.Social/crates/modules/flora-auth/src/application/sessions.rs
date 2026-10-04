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
        current_session_id: Uuid,
    ) -> Result<Vec<SessionListItem>, sqlx::Error> {
        let now = chrono::Utc::now();
        let rows = self.repo.list_active_sessions(user_uuid, now).await?;
        Ok(rows
            .into_iter()
            .map(|s| SessionListItem {
                is_current: s.session_id == current_session_id,
                session_id: s.session_id,
                created_at: format_utc(s.created_at),
                last_activity: format_utc(s.last_activity),
                ip_address: s.ip_address,
                city: s.city,
                country_code: s.country_code,
            })
            .collect())
    }

    /// Завершить все сессии, кроме текущей (по стабильному `session_id`). Ответ:
    /// число отозванных. Ротация JTI текущей сессии не влияет на исключение.
    pub async fn revoke_others(
        &self,
        user_uuid: Uuid,
        current_session_id: Uuid,
    ) -> Result<u64, sqlx::Error> {
        let now = chrono::Utc::now();
        self.repo
            .revoke_other_sessions_except_id(user_uuid, Some(current_session_id), now)
            .await
    }

    /// Logout текущей сессии по стабильному `session_id`. Параллельная ротация
    /// JTI не может обойти logout: строка отзывается по неизменному id.
    pub async fn logout_current(&self, session_id: Uuid) -> Result<(), sqlx::Error> {
        self.repo.revoke_by_session_id_logout(session_id).await?;
        Ok(())
    }
}
