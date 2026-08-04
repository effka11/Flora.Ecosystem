//! PasswordResetHook → Messaging E2E lock after Auth password reset.

use std::sync::Arc;

use flora_auth_contracts::{BoxFuture, PasswordResetHook};
use sqlx::PgPool;
use uuid::Uuid;

use crate::infrastructure::lock_account;

/// Product-facing hook: Active/ActiveNewEpoch → Locked; other states no-op
/// (including Frozen — see `lock_account` / `should_set_locked_after_password_reset`).
pub fn password_reset_hook(pool: PgPool) -> Arc<dyn PasswordResetHook> {
    Arc::new(PasswordResetLockHook { pool })
}

struct PasswordResetLockHook {
    pool: PgPool,
}

impl PasswordResetHook for PasswordResetLockHook {
    fn after_password_reset(&self, user_uuid: Uuid) -> BoxFuture<'_, Result<(), String>> {
        let pool = self.pool.clone();
        Box::pin(async move { lock_account(&pool, user_uuid).await })
    }
}
