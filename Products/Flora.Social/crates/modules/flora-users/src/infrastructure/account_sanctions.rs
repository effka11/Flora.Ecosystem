//! PostgreSQL adapter for account-wide sanctions owned by Users.

use chrono::{DateTime, Utc};
use flora_users_contracts::{AccountSanctionStatus, AccountSanctions, BoxFuture};
use sqlx::PgPool;
use uuid::Uuid;

/// Состояние аккаунт-санкции вместе со сроком — только для ответов самого Users.
///
/// Порт `AccountSanctionStatus` отдаёт наружу лишь `bool`: срок — внутреннее
/// знание модуля-владельца, интерпретировать его другим модулям нельзя.
/// `Forever` ⇒ `accountBlockedUntil: null`, `Until` ⇒ ISO-строка.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountBlockState {
    /// Активной санкции нет (строки нет либо срок истёк).
    Inactive,
    /// Активная санкция без срока.
    Forever,
    /// Активная санкция до указанного момента.
    Until(DateTime<Utc>),
}

pub struct SqlAccountSanctions {
    pool: PgPool,
}

impl SqlAccountSanctions {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Активная санкция и её срок одним запросом (`GET /api/auth/me`).
    /// Inherent, не метод порта: срок не покидает Users.
    pub async fn block_state(&self, user_uuid: Uuid) -> Result<AccountBlockState, String> {
        let row: Option<(Option<DateTime<Utc>>,)> = sqlx::query_as(
            r#"
            SELECT blocked_until
            FROM flora_core.user_account_blocks
            WHERE user_uuid = $1
              AND (blocked_until IS NULL OR blocked_until > now())
            "#,
        )
        .bind(user_uuid)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(match row {
            None => AccountBlockState::Inactive,
            Some((None,)) => AccountBlockState::Forever,
            Some((Some(until),)) => AccountBlockState::Until(until),
        })
    }
}

impl AccountSanctions for SqlAccountSanctions {
    fn apply_block(
        &self,
        user_uuid: Uuid,
        blocked_until: Option<DateTime<Utc>>,
        created_by: Uuid,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            sqlx::query(
                r#"
                INSERT INTO flora_core.user_account_blocks
                    (user_uuid, blocked_until, created_at, created_by)
                VALUES ($1, $2, now(), $3)
                ON CONFLICT (user_uuid) DO UPDATE
                SET blocked_until = EXCLUDED.blocked_until,
                    created_at = EXCLUDED.created_at,
                    created_by = EXCLUDED.created_by
                "#,
            )
            .bind(user_uuid)
            .bind(blocked_until)
            .bind(created_by)
            .execute(&self.pool)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
    }
}

impl AccountSanctionStatus for SqlAccountSanctions {
    fn is_blocked(&self, user_uuid: Uuid) -> BoxFuture<'_, Result<bool, String>> {
        Box::pin(async move {
            sqlx::query_scalar(
                r#"
                SELECT EXISTS(
                    SELECT 1
                    FROM flora_core.user_account_blocks
                    WHERE user_uuid = $1
                      AND (blocked_until IS NULL OR blocked_until > now())
                )
                "#,
            )
            .bind(user_uuid)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.to_string())
        })
    }

    fn blocked_among(&self, user_uuids: &[Uuid]) -> BoxFuture<'_, Result<Vec<Uuid>, String>> {
        let ids = user_uuids.to_vec();
        Box::pin(async move {
            if ids.is_empty() {
                return Ok(Vec::new());
            }
            sqlx::query_scalar(
                r#"
                SELECT user_uuid
                FROM flora_core.user_account_blocks
                WHERE user_uuid = ANY($1)
                  AND (blocked_until IS NULL OR blocked_until > now())
                ORDER BY user_uuid
                "#,
            )
            .bind(&ids)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn blocked_among_empty_does_not_connect() {
        let pool = PgPool::connect_lazy("postgres://unused@127.0.0.1:1/unused")
            .expect("valid lazy PostgreSQL URL");
        let adapter = SqlAccountSanctions::new(pool);

        assert_eq!(adapter.blocked_among(&[]).await, Ok(Vec::new()));
    }
}
