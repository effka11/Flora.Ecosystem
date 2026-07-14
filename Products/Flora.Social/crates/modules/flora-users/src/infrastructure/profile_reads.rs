use flora_users_contracts::{BoxFuture, UserProfileReadQueries};
use sqlx::PgPool;
use uuid::Uuid;

pub struct SqlUserProfileReadQueries {
    pool: PgPool,
}

impl SqlUserProfileReadQueries {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

impl UserProfileReadQueries for SqlUserProfileReadQueries {
    fn requires_profile_completion(
        &self,
        user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<bool, String>> {
        Box::pin(async move {
            let display_name: Option<Option<String>> = sqlx::query_scalar(
                r#"
                SELECT display_name
                FROM flora_core.user_profiles
                WHERE user_uuid = $1
                "#,
            )
            .bind(user_uuid)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| e.to_string())?;

            Ok(match display_name {
                None => true,
                Some(None) => true,
                Some(Some(name)) => name.trim().is_empty(),
            })
        })
    }
}
