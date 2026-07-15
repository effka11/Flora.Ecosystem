//! FIRA-P candidate pool — паритет `UserRecommendationQueries.cs`.

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RecommendationCandidateRow {
    pub user_uuid: Uuid,
    pub display_name: String,
    pub avatar_uuid: Option<Uuid>,
    pub updated_at: DateTime<Utc>,
    pub follower_count: i32,
    pub followed_by_following_count: i32,
}

pub struct SqlUserRecommendationQueries {
    pool: PgPool,
}

impl SqlUserRecommendationQueries {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn get_candidates(
        &self,
        user_uuid: Uuid,
        following_user_ids: &[Uuid],
    ) -> Result<Vec<RecommendationCandidateRow>, sqlx::Error> {
        let mut excluded: Vec<Uuid> = following_user_ids.to_vec();
        excluded.push(user_uuid);

        let blocked: Vec<Uuid> = sqlx::query_scalar(
            r#"
            SELECT CASE
                WHEN owner_user_uuid = $1 THEN blocked_user_uuid
                ELSE owner_user_uuid
            END
            FROM flora_core.user_blocks
            WHERE owner_user_uuid = $1 OR blocked_user_uuid = $1
            "#,
        )
        .bind(user_uuid)
        .fetch_all(&self.pool)
        .await?;
        excluded.extend(blocked);

        let profiles: Vec<(Uuid, String, Option<Uuid>, DateTime<Utc>)> = sqlx::query_as(
            r#"
            SELECT user_uuid, display_name, avatar_uuid, updated_at
            FROM flora_core.user_profiles
            WHERE user_uuid <> ALL($1::uuid[])
            "#,
        )
        .bind(&excluded)
        .fetch_all(&self.pool)
        .await?;

        if profiles.is_empty() {
            return Ok(Vec::new());
        }

        let user_ids: Vec<Uuid> = profiles.iter().map(|(id, _, _, _)| *id).collect();

        let follower_rows: Vec<(Uuid, i64)> = sqlx::query_as(
            r#"
            SELECT following_user_uuid, count(*)::bigint
            FROM flora_core.user_followers
            WHERE following_user_uuid = ANY($1)
            GROUP BY following_user_uuid
            "#,
        )
        .bind(&user_ids)
        .fetch_all(&self.pool)
        .await?;
        let follower_by: std::collections::HashMap<_, _> = follower_rows.into_iter().collect();

        let social_by: std::collections::HashMap<Uuid, i32> = if following_user_ids.is_empty() {
            std::collections::HashMap::new()
        } else {
            let social_rows: Vec<(Uuid, i64)> = sqlx::query_as(
                r#"
                SELECT following_user_uuid, count(*)::bigint
                FROM flora_core.user_followers
                WHERE following_user_uuid = ANY($1)
                  AND follower_user_uuid = ANY($2)
                GROUP BY following_user_uuid
                "#,
            )
            .bind(&user_ids)
            .bind(following_user_ids)
            .fetch_all(&self.pool)
            .await?;
            social_rows
                .into_iter()
                .map(|(id, n)| (id, i32::try_from(n).unwrap_or(i32::MAX)))
                .collect()
        };

        Ok(profiles
            .into_iter()
            .map(|(uid, display_name, avatar_uuid, updated_at)| RecommendationCandidateRow {
                user_uuid: uid,
                display_name,
                avatar_uuid,
                updated_at,
                follower_count: i32::try_from(*follower_by.get(&uid).unwrap_or(&0))
                    .unwrap_or(i32::MAX),
                followed_by_following_count: *social_by.get(&uid).unwrap_or(&0),
            })
            .collect())
    }
}
