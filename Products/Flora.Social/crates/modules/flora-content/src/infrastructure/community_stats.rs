//! Статистика подписок на сообщества для Users GET /me.

use std::sync::Arc;

use flora_content_contracts::{BoxFuture, CommunityFollowStats};
use sqlx::PgPool;
use uuid::Uuid;

pub struct SqlCommunityFollowStats {
    pool: PgPool,
}

impl SqlCommunityFollowStats {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

impl CommunityFollowStats for SqlCommunityFollowStats {
    fn count_public_following(&self, user_uuid: Uuid) -> BoxFuture<'_, Result<i64, String>> {
        Box::pin(async move {
            let count: i64 = sqlx::query_scalar(
                r#"
                SELECT count(*)::bigint
                FROM flora_core.user_communities uc
                INNER JOIN flora_core.communities c ON c.community_id = uc.community_id
                WHERE uc.user_uuid = $1
                  AND uc.role <> 'Owner'
                  AND c.is_private = false
                "#,
            )
            .bind(user_uuid)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
            Ok(count)
        })
    }
}

pub fn community_follow_stats(pool: PgPool) -> Arc<dyn CommunityFollowStats> {
    Arc::new(SqlCommunityFollowStats::new(pool))
}
