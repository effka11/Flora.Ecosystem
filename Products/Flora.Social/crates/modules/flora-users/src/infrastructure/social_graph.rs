//! Адаптеры FollowGraph / Blocklist / FeedAuthorProfiles для Content ServeNative.

use std::sync::Arc;

use flora_users_contracts::{
    AccountSanctionStatus, BidirectionalBlocklist, BoxFuture, FeedAuthorProfile,
    FeedAuthorProfiles, FollowGraphReader,
};
use sqlx::PgPool;
use uuid::Uuid;

use crate::infrastructure::account_sanctions::SqlAccountSanctions;

pub struct SqlSocialGraph {
    pool: PgPool,
    /// Санкции читаем через собственный адаптер Users: предикат активности
    /// («без срока либо срок не истёк») живёт в одном месте.
    sanctions: SqlAccountSanctions,
}

impl SqlSocialGraph {
    pub fn new(pool: PgPool) -> Self {
        Self {
            sanctions: SqlAccountSanctions::new(pool.clone()),
            pool,
        }
    }
}

impl FollowGraphReader for SqlSocialGraph {
    fn following_user_ids(
        &self,
        follower_user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<Vec<Uuid>, String>> {
        Box::pin(async move {
            sqlx::query_scalar(
                r#"
                SELECT following_user_uuid
                FROM flora_core.user_followers
                WHERE follower_user_uuid = $1
                "#,
            )
            .bind(follower_user_uuid)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string())
        })
    }

    fn following_user_ids_for_followers(
        &self,
        follower_user_uuids: &[Uuid],
        exclude_user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<Vec<Uuid>, String>> {
        let ids = follower_user_uuids.to_vec();
        Box::pin(async move {
            if ids.is_empty() {
                return Ok(Vec::new());
            }
            sqlx::query_scalar(
                r#"
                SELECT DISTINCT following_user_uuid
                FROM flora_core.user_followers
                WHERE follower_user_uuid = ANY($1)
                  AND following_user_uuid <> $2
                "#,
            )
            .bind(&ids)
            .bind(exclude_user_uuid)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string())
        })
    }

    fn follower_counts(
        &self,
        user_ids: &[Uuid],
    ) -> BoxFuture<'_, Result<Vec<(Uuid, i32)>, String>> {
        let ids = user_ids.to_vec();
        Box::pin(async move {
            if ids.is_empty() {
                return Ok(Vec::new());
            }
            let rows: Vec<(Uuid, i64)> = sqlx::query_as(
                r#"
                SELECT following_user_uuid, COUNT(*)::bigint
                FROM flora_core.user_followers
                WHERE following_user_uuid = ANY($1)
                GROUP BY following_user_uuid
                "#,
            )
            .bind(&ids)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
            Ok(rows
                .into_iter()
                .map(|(id, n)| (id, i32::try_from(n).unwrap_or(i32::MAX)))
                .collect())
        })
    }
}

impl BidirectionalBlocklist for SqlSocialGraph {
    fn blocked_user_ids_bidirectional(
        &self,
        user_uuid: Uuid,
    ) -> BoxFuture<'_, Result<Vec<Uuid>, String>> {
        Box::pin(async move {
            let rows: Vec<(Uuid, Uuid)> = sqlx::query_as(
                r#"
                SELECT owner_user_uuid, blocked_user_uuid
                FROM flora_core.user_blocks
                WHERE owner_user_uuid = $1 OR blocked_user_uuid = $1
                "#,
            )
            .bind(user_uuid)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
            Ok(rows
                .into_iter()
                .map(
                    |(owner, blocked)| {
                        if owner == user_uuid { blocked } else { owner }
                    },
                )
                .collect())
        })
    }
}

impl FeedAuthorProfiles for SqlSocialGraph {
    fn by_uuids(
        &self,
        user_uuids: &[Uuid],
    ) -> BoxFuture<'_, Result<Vec<FeedAuthorProfile>, String>> {
        let ids = user_uuids.to_vec();
        Box::pin(async move {
            if ids.is_empty() {
                return Ok(Vec::new());
            }
            let rows: Vec<(Uuid, Option<String>, Option<Uuid>)> = sqlx::query_as(
                r#"
                SELECT user_uuid, display_name, avatar_uuid
                FROM flora_core.user_profiles
                WHERE user_uuid = ANY($1)
                "#,
            )
            .bind(&ids)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
            // Батч санкций (без N+1): у заблокированного автора потребитель
            // не должен получить avatar_uuid, сам блоб при этом сохраняется.
            let blocked: std::collections::HashSet<Uuid> = self
                .sanctions
                .blocked_among(&ids)
                .await?
                .into_iter()
                .collect();
            Ok(rows
                .into_iter()
                .map(|(user_uuid, display_name, avatar_uuid)| {
                    let account_blocked = blocked.contains(&user_uuid);
                    FeedAuthorProfile {
                        user_uuid,
                        display_name: display_name.unwrap_or_default(),
                        avatar_uuid: if account_blocked { None } else { avatar_uuid },
                        account_blocked,
                    }
                })
                .collect())
        })
    }
}

pub fn as_ports(
    pool: PgPool,
) -> (
    Arc<dyn FollowGraphReader>,
    Arc<dyn BidirectionalBlocklist>,
    Arc<dyn FeedAuthorProfiles>,
) {
    let g = Arc::new(SqlSocialGraph::new(pool));
    (g.clone(), g.clone(), g)
}
