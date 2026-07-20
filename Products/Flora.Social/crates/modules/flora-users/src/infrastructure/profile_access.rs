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
                ProfileAccessField::Friends => {
                    fetch_visibility(
                        &self.pool,
                        owner_user_uuid,
                        r#"
                    SELECT friends_visibility
                    FROM flora_core.user_privacy_settings
                    WHERE user_uuid = $1
                    "#,
                        VIS_ALL,
                    )
                    .await?
                }
                ProfileAccessField::Subscriptions => {
                    fetch_visibility(
                        &self.pool,
                        owner_user_uuid,
                        r#"
                    SELECT subscriptions_visibility
                    FROM flora_core.user_privacy_settings
                    WHERE user_uuid = $1
                    "#,
                        VIS_ALL,
                    )
                    .await?
                }
                ProfileAccessField::Posts => {
                    fetch_visibility(
                        &self.pool,
                        owner_user_uuid,
                        r#"
                    SELECT posts_visibility
                    FROM flora_core.user_privacy_settings
                    WHERE user_uuid = $1
                    "#,
                        VIS_ALL,
                    )
                    .await?
                }
                ProfileAccessField::Likes => {
                    fetch_visibility(
                        &self.pool,
                        owner_user_uuid,
                        r#"
                    SELECT likes_visibility
                    FROM flora_core.user_privacy_settings
                    WHERE user_uuid = $1
                    "#,
                        VIS_FRIENDS,
                    )
                    .await?
                }
                ProfileAccessField::Reposts => {
                    fetch_visibility(
                        &self.pool,
                        owner_user_uuid,
                        r#"
                    SELECT reposts_visibility
                    FROM flora_core.user_privacy_settings
                    WHERE user_uuid = $1
                    "#,
                        VIS_ALL,
                    )
                    .await?
                }
                ProfileAccessField::Comments => {
                    fetch_visibility(
                        &self.pool,
                        owner_user_uuid,
                        r#"
                    SELECT comments_from
                    FROM flora_core.user_privacy_settings
                    WHERE user_uuid = $1
                    "#,
                        VIS_ALL,
                    )
                    .await?
                }
            };

            evaluate_visibility(&self.pool, viewer_user_uuid, owner_user_uuid, visibility).await
        })
    }

    fn accessible_owners(
        &self,
        viewer_user_uuid: Option<Uuid>,
        owner_user_uuids: &[Uuid],
        field: ProfileAccessField,
    ) -> BoxFuture<'_, Result<Vec<Uuid>, String>> {
        let owners = owner_user_uuids.to_vec();
        Box::pin(async move {
            if owners.is_empty() {
                return Ok(Vec::new());
            }
            let (column, default) = match field {
                ProfileAccessField::Friends => ("friends_visibility", VIS_ALL),
                ProfileAccessField::Subscriptions => ("subscriptions_visibility", VIS_ALL),
                ProfileAccessField::Posts => ("posts_visibility", VIS_ALL),
                ProfileAccessField::Likes => ("likes_visibility", VIS_FRIENDS),
                ProfileAccessField::Reposts => ("reposts_visibility", VIS_ALL),
                ProfileAccessField::Comments => ("comments_from", VIS_ALL),
            };
            // `column` comes only from the closed enum above; values remain bound.
            let sql = format!(
                r#"
                SELECT DISTINCT owners.owner_uuid
                FROM UNNEST($1::uuid[]) AS owners(owner_uuid)
                LEFT JOIN flora_core.user_privacy_settings privacy
                  ON privacy.user_uuid = owners.owner_uuid
                WHERE owners.owner_uuid = $2
                   OR (
                        (
                          $2::uuid IS NULL
                          OR NOT EXISTS (
                              SELECT 1
                              FROM flora_core.user_blocks blocks
                              WHERE blocks.owner_user_uuid = owners.owner_uuid
                                AND blocks.blocked_user_uuid = $2
                          )
                        )
                        AND (
                          COALESCE(privacy.{column}, $3) = {VIS_ALL}
                          OR (
                            COALESCE(privacy.{column}, $3) = {VIS_FRIENDS}
                            AND $2::uuid IS NOT NULL
                            AND EXISTS (
                                SELECT 1
                                FROM flora_core.user_followers forward_edge
                                WHERE forward_edge.follower_user_uuid = $2
                                  AND forward_edge.following_user_uuid = owners.owner_uuid
                            )
                            AND EXISTS (
                                SELECT 1
                                FROM flora_core.user_followers reverse_edge
                                WHERE reverse_edge.follower_user_uuid = owners.owner_uuid
                                  AND reverse_edge.following_user_uuid = $2
                            )
                          )
                        )
                      )
                "#,
            );
            sqlx::query_scalar::<_, Uuid>(sqlx::AssertSqlSafe(sql.as_str()))
                .bind(&owners)
                .bind(viewer_user_uuid)
                .bind(default)
                .fetch_all(&self.pool)
                .await
                .map_err(|e| e.to_string())
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
