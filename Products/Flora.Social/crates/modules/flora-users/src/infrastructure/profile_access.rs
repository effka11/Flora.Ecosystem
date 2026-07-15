//! ProfileAccess — паритет `ProfileAccessPolicy` для секций профиля.

use flora_users_contracts::{BoxFuture, ProfileAccess, ProfileAccessField};
use sqlx::PgPool;
use uuid::Uuid;

const VIS_ALL: i32 = 0;
const VIS_FRIENDS: i32 = 1;
const VIS_NONE: i32 = 2;

pub struct SqlProfileAccess {
    pool: PgPool,
}

impl SqlProfileAccess {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

impl ProfileAccess for SqlProfileAccess {
    fn can_access(
        &self,
        viewer_user_uuid: Option<Uuid>,
        owner_user_uuid: Uuid,
        field: ProfileAccessField,
    ) -> BoxFuture<'_, Result<bool, String>> {
        Box::pin(async move {
            if viewer_user_uuid == Some(owner_user_uuid) {
                return Ok(true);
            }

            if let Some(viewer) = viewer_user_uuid {
                let blocked: bool = sqlx::query_scalar(
                    r#"
                    SELECT EXISTS(
                        SELECT 1 FROM flora_core.user_blocks
                        WHERE owner_user_uuid = $1 AND blocked_user_uuid = $2
                    )
                    "#,
                )
                .bind(owner_user_uuid)
                .bind(viewer)
                .fetch_one(&self.pool)
                .await
                .map_err(|e| e.to_string())?;
                if blocked {
                    return Ok(false);
                }
            }

            let visibility: i32 = match field {
                ProfileAccessField::Friends => fetch_visibility(
                    &self.pool,
                    owner_user_uuid,
                    r#"
                    SELECT friends_visibility
                    FROM flora_core.user_privacy_settings
                    WHERE user_uuid = $1
                    "#,
                    VIS_ALL,
                )
                .await?,
                ProfileAccessField::Subscriptions => fetch_visibility(
                    &self.pool,
                    owner_user_uuid,
                    r#"
                    SELECT subscriptions_visibility
                    FROM flora_core.user_privacy_settings
                    WHERE user_uuid = $1
                    "#,
                    VIS_ALL,
                )
                .await?,
                ProfileAccessField::Posts => fetch_visibility(
                    &self.pool,
                    owner_user_uuid,
                    r#"
                    SELECT posts_visibility
                    FROM flora_core.user_privacy_settings
                    WHERE user_uuid = $1
                    "#,
                    VIS_ALL,
                )
                .await?,
                ProfileAccessField::Likes => fetch_visibility(
                    &self.pool,
                    owner_user_uuid,
                    r#"
                    SELECT likes_visibility
                    FROM flora_core.user_privacy_settings
                    WHERE user_uuid = $1
                    "#,
                    VIS_FRIENDS,
                )
                .await?,
                ProfileAccessField::Reposts => fetch_visibility(
                    &self.pool,
                    owner_user_uuid,
                    r#"
                    SELECT reposts_visibility
                    FROM flora_core.user_privacy_settings
                    WHERE user_uuid = $1
                    "#,
                    VIS_ALL,
                )
                .await?,
                ProfileAccessField::Comments => fetch_visibility(
                    &self.pool,
                    owner_user_uuid,
                    r#"
                    SELECT comments_from
                    FROM flora_core.user_privacy_settings
                    WHERE user_uuid = $1
                    "#,
                    VIS_ALL,
                )
                .await?,
            };

            evaluate_visibility(&self.pool, viewer_user_uuid, owner_user_uuid, visibility).await
        })
    }
}

async fn fetch_visibility(
    pool: &PgPool,
    owner_user_uuid: Uuid,
    sql: &'static str,
    default: i32,
) -> Result<i32, String> {
    Ok(sqlx::query_scalar(sql)
        .bind(owner_user_uuid)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or(default))
}

async fn evaluate_visibility(
    pool: &PgPool,
    viewer_user_uuid: Option<Uuid>,
    owner_user_uuid: Uuid,
    visibility: i32,
) -> Result<bool, String> {
    match visibility {
        VIS_ALL => Ok(true),
        VIS_NONE => Ok(false),
        VIS_FRIENDS => {
            let Some(viewer) = viewer_user_uuid else {
                return Ok(false);
            };
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
            .bind(viewer)
            .bind(owner_user_uuid)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
            Ok(is_friend)
        }
        _ => Ok(false),
    }
}
