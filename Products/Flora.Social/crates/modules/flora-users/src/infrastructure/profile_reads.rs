use flora_users_contracts::{BoxFuture, UserProfileProvisioner, UserProfileReadQueries};
use sqlx::PgPool;
use uuid::Uuid;

pub struct SqlUserProfileQueries {
    pool: PgPool,
}

impl SqlUserProfileQueries {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

impl UserProfileReadQueries for SqlUserProfileQueries {
    fn requires_profile_completion(&self, user_uuid: Uuid) -> BoxFuture<'_, Result<bool, String>> {
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

impl UserProfileProvisioner for SqlUserProfileQueries {
    fn ensure_initial_profile(
        &self,
        user_uuid: Uuid,
        display_name: &str,
        _username: &str,
    ) -> BoxFuture<'_, Result<(), String>> {
        let display_name = display_name.to_string();
        Box::pin(async move {
            let exists: bool = sqlx::query_scalar(
                r#"
                SELECT EXISTS(
                    SELECT 1 FROM flora_core.user_profiles WHERE user_uuid = $1
                )
                "#,
            )
            .bind(user_uuid)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
            if exists {
                return Ok(());
            }
            sqlx::query(
                r#"
                INSERT INTO flora_core.user_profiles (user_uuid, display_name)
                VALUES ($1, $2)
                "#,
            )
            .bind(user_uuid)
            .bind(display_name)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    fn forget_user(&self, _user_uuid: Uuid) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}
