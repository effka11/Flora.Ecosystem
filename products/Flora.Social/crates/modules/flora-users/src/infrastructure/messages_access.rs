//! MessagesAccess — паритет `ProfileAccessPolicy` для Messages.

use flora_users_contracts::{AccountSanctionStatus, BoxFuture, MessagesAccess};
use sqlx::PgPool;
use uuid::Uuid;

use crate::infrastructure::account_sanctions::SqlAccountSanctions;
use crate::infrastructure::store::{MSG_ALL, MSG_FRIENDS};

pub struct SqlMessagesAccess {
    pool: PgPool,
    /// Санкции читаем через собственный адаптер Users: предикат активности
    /// («без срока либо срок не истёк») живёт в одном месте.
    sanctions: SqlAccountSanctions,
}

impl SqlMessagesAccess {
    pub fn new(pool: PgPool) -> Self {
        Self {
            sanctions: SqlAccountSanctions::new(pool.clone()),
            pool,
        }
    }
}

impl MessagesAccess for SqlMessagesAccess {
    fn can_send_messages(
        &self,
        viewer_user_uuid: Uuid,
        subject_user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<bool, String>> {
        Box::pin(async move {
            // Аккаунт-санкция сильнее приватности и сильнее self-переписки:
            // заблокированному нельзя ни писать, ни получать — включая «себе».
            let account_blocked = self
                .sanctions
                .blocked_among(&[viewer_user_uuid, subject_user_uuid])
                .await?;
            if !account_blocked.is_empty() {
                return Ok(false);
            }

            if viewer_user_uuid == subject_user_uuid {
                return Ok(true);
            }

            // Subject заблокировал viewer → нельзя писать.
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

            let messages_from: i32 = sqlx::query_scalar(
                r#"
                SELECT messages_from
                FROM flora_core.user_privacy_settings
                WHERE user_uuid = $1
                "#,
            )
            .bind(subject_user_uuid)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or(MSG_ALL);

            match messages_from {
                MSG_ALL => Ok(true),
                MSG_FRIENDS => {
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
                    Ok(is_friend)
                }
                _ => Ok(false),
            }
        })
    }
}
