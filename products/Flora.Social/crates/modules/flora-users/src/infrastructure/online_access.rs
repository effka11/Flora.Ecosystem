//! OnlineStatusAccess — паритет `ProfileAccessPolicy` для OnlineStatus.

use flora_users_contracts::{BoxFuture, OnlineStatusAccess};
use sqlx::PgPool;
use uuid::Uuid;

use crate::infrastructure::store::{ONLINE_HIDDEN, ONLINE_VISIBLE};

pub struct SqlOnlineStatusAccess {
    pool: PgPool,
}

impl SqlOnlineStatusAccess {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

impl OnlineStatusAccess for SqlOnlineStatusAccess {
    fn can_see_online(
        &self,
        viewer_user_uuid: Uuid,
        subject_user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<bool, String>> {
        Box::pin(async move {
            if viewer_user_uuid == subject_user_uuid {
                return Ok(true);
            }

            // Subject заблокировал viewer → скрыть.
            let blocked: bool = sqlx::query_scalar(
                r#"
                SELECT EXISTS(
                    SELECT 1 FROM flora_core.user_blocks
                    WHERE owner_user_uuid = $1 AND blocked_user_uuid = $2
                )
                "#,
            )
            .bind(subject_user_uuid)
            .bind(viewer_user_uuid)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
            if blocked {
                return Ok(false);
            }

            let row: Option<(i32, i32)> = sqlx::query_as(
                r#"
                SELECT online_friends, online_strangers
                FROM flora_core.user_privacy_settings
                WHERE user_uuid = $1
                "#,
            )
            .bind(subject_user_uuid)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| e.to_string())?;

            let (online_friends, online_strangers) = row.unwrap_or((ONLINE_VISIBLE, ONLINE_HIDDEN));

            let is_friend: bool = sqlx::query_scalar(
                r#"
                SELECT EXISTS(
                    SELECT 1 FROM flora_core.user_followers
                    WHERE follower_user_uuid = $1 AND following_user_uuid = $2
                )
                AND EXISTS(
                    SELECT 1 FROM flora_core.user_followers
                    WHERE follower_user_uuid = $2 AND following_user_uuid = $1
                )
                "#,
            )
            .bind(viewer_user_uuid)
            .bind(subject_user_uuid)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.to_string())?;

            Ok(if is_friend {
                online_friends == ONLINE_VISIBLE
            } else {
                online_strangers == ONLINE_VISIBLE
            })
        })
    }
}
