//! sqlx-репозиторий Auth (`user_sessions`, `user_accounts`).

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

const STATUS_ACTIVE: i32 = 0;
/// `UserSessionStatus.RevokedUser` — паритет с C#.
const STATUS_REVOKED_USER: i32 = 4;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SessionRow {
    pub session_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub last_activity: DateTime<Utc>,
    pub ip_address: String,
    pub city: Option<String>,
    pub country_code: Option<String>,
    pub jwt_id: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SecurityStatusRow {
    pub two_factor_enabled: bool,
    pub email_verified: bool,
    pub phone_verified: bool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RefreshSessionRow {
    pub session_id: Uuid,
    pub user_uuid: Uuid,
    pub rotation_id: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AccountIdentityRow {
    pub phone: Option<String>,
    pub email: Option<String>,
    pub username: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct LoginAccountRow {
    pub user_uuid: Uuid,
    pub password_hash: String,
    pub email: Option<String>,
    pub phone: String,
    pub two_factor_enabled: bool,
    pub two_factor_secret: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SecurityLogRow {
    pub user_uuid: Uuid,
    pub login_failures: i16,
    pub login_locked_until: Option<DateTime<Utc>>,
}

pub struct AuthRepo {
    pool: PgPool,
}

impl AuthRepo {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn list_active_sessions(
        &self,
        user_uuid: Uuid,
        now: DateTime<Utc>,
    ) -> Result<Vec<SessionRow>, sqlx::Error> {
        sqlx::query_as::<_, SessionRow>(
            r#"
            SELECT session_id, created_at, last_activity, ip_address, city, country_code, jwt_id
            FROM flora_core.user_sessions
            WHERE user_uuid = $1
              AND status = $2
              AND expires_at > $3
            ORDER BY last_activity DESC
            "#,
        )
        .bind(user_uuid)
        .bind(STATUS_ACTIVE)
        .bind(now)
        .fetch_all(&self.pool)
        .await
    }

    /// Завершить все активные сессии пользователя, кроме текущей (по `jwt_id`).
    /// Если `current_jti` пуст — отзываются все активные (как в C#).
    pub async fn revoke_other_sessions(
        &self,
        user_uuid: Uuid,
        current_jti: &str,
        now: DateTime<Utc>,
    ) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            r#"
            UPDATE flora_core.user_sessions
            SET status = $1
            WHERE user_uuid = $2
              AND status = $3
              AND expires_at > $4
              AND ($5 = '' OR jwt_id <> $5)
            "#,
        )
        .bind(STATUS_REVOKED_USER)
        .bind(user_uuid)
        .bind(STATUS_ACTIVE)
        .bind(now)
        .bind(current_jti)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    /// Отозвать сессию по `jwt_id` (logout). Как в C#: без фильтра по status.
    pub async fn revoke_by_jwt_id(&self, jwt_id: &str) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            r#"
            UPDATE flora_core.user_sessions
            SET status = $1
            WHERE jwt_id = $2
            "#,
        )
        .bind(STATUS_REVOKED_USER)
        .bind(jwt_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    /// Сводка безопасности. `None` → как C#: все флаги false.
    pub async fn get_security_status(
        &self,
        user_uuid: Uuid,
    ) -> Result<Option<SecurityStatusRow>, sqlx::Error> {
        sqlx::query_as::<_, SecurityStatusRow>(
            r#"
            SELECT two_factor_enabled, email_verified, phone_verified
            FROM flora_core.user_accounts
            WHERE user_uuid = $1
            "#,
        )
        .bind(user_uuid)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn find_active_session_by_refresh(
        &self,
        refresh_token: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<RefreshSessionRow>, sqlx::Error> {
        sqlx::query_as::<_, RefreshSessionRow>(
            r#"
            SELECT session_id, user_uuid, rotation_id
            FROM flora_core.user_sessions
            WHERE refresh_token = $1
              AND status = $2
              AND expires_at > $3
            "#,
        )
        .bind(refresh_token)
        .bind(STATUS_ACTIVE)
        .bind(now)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn get_account_identity(
        &self,
        user_uuid: Uuid,
    ) -> Result<AccountIdentityRow, sqlx::Error> {
        sqlx::query_as::<_, AccountIdentityRow>(
            r#"
            SELECT phone, email, username
            FROM flora_core.user_accounts
            WHERE user_uuid = $1
            "#,
        )
        .bind(user_uuid)
        .fetch_one(&self.pool)
        .await
    }

    pub async fn rotate_session(
        &self,
        session_id: Uuid,
        new_jwt_id: &str,
        new_refresh_token: &str,
        expires_at: DateTime<Utc>,
        last_activity: DateTime<Utc>,
        new_rotation_id: i64,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE flora_core.user_sessions
            SET jwt_id = $1,
                refresh_token = $2,
                expires_at = $3,
                last_activity = $4,
                rotation_id = $5
            WHERE session_id = $6
            "#,
        )
        .bind(new_jwt_id)
        .bind(new_refresh_token)
        .bind(expires_at)
        .bind(last_activity)
        .bind(new_rotation_id)
        .bind(session_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn cleanup_expired_pending(&self, now: DateTime<Utc>) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            r#"
            DELETE FROM flora_core.pending_registrations
            WHERE expires_at <= $1
            "#,
        )
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    pub async fn find_active_account_by_identifier(
        &self,
        identifier: &str,
    ) -> Result<Option<LoginAccountRow>, sqlx::Error> {
        sqlx::query_as::<_, LoginAccountRow>(
            r#"
            SELECT user_uuid, password_hash, email, phone,
                   two_factor_enabled, two_factor_secret
            FROM flora_core.user_accounts
            WHERE status = 0
              AND (email = $1 OR phone = $1)
            "#,
        )
        .bind(identifier)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn get_security_log(
        &self,
        user_uuid: Uuid,
    ) -> Result<Option<SecurityLogRow>, sqlx::Error> {
        sqlx::query_as::<_, SecurityLogRow>(
            r#"
            SELECT user_uuid, login_failures::smallint AS login_failures, login_locked_until
            FROM flora_core.user_security_logs
            WHERE user_uuid = $1
            "#,
        )
        .bind(user_uuid)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn upsert_login_failure(
        &self,
        user_uuid: Uuid,
        now: DateTime<Utc>,
        new_failures: u8,
        locked_until: Option<DateTime<Utc>>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.user_security_logs (
                user_uuid, password_updated_at, login_failures, login_locked_until,
                created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $2, $2)
            ON CONFLICT (user_uuid) DO UPDATE SET
                login_failures = EXCLUDED.login_failures,
                login_locked_until = EXCLUDED.login_locked_until,
                updated_at = EXCLUDED.updated_at
            "#,
        )
        .bind(user_uuid)
        .bind(now)
        .bind(new_failures as i16)
        .bind(locked_until)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn clear_login_failures_on_success(
        &self,
        user_uuid: Uuid,
        now: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE flora_core.user_security_logs
            SET login_failures = 0,
                login_locked_until = NULL,
                last_login = $2,
                updated_at = $2
            WHERE user_uuid = $1
            "#,
        )
        .bind(user_uuid)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn touch_account_last_login(
        &self,
        user_uuid: Uuid,
        now: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE flora_core.user_accounts
            SET last_login = $2
            WHERE user_uuid = $1
            "#,
        )
        .bind(user_uuid)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn insert_session(
        &self,
        session_id: Uuid,
        user_uuid: Uuid,
        agent_hash: &str,
        ip_address: &str,
        expires_at: DateTime<Utc>,
        now: DateTime<Utc>,
        jwt_id: &str,
        refresh_token: &str,
        csrf_token: &str,
        hmac_key: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.user_sessions (
                session_id, user_uuid, agent_hash, ip_address,
                created_at, expires_at, last_activity,
                jwt_id, refresh_token, rotation_id, status,
                csrf_token, hmac_key
            ) VALUES (
                $1, $2, $3, $4,
                $5, $6, $5,
                $7, $8, 0, 0,
                $9, $10
            )
            "#,
        )
        .bind(session_id)
        .bind(user_uuid)
        .bind(agent_hash)
        .bind(ip_address)
        .bind(now)
        .bind(expires_at)
        .bind(jwt_id)
        .bind(refresh_token)
        .bind(csrf_token)
        .bind(hmac_key)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn email_exists(&self, email: &str) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM flora_core.user_accounts WHERE email = $1
            )
            "#,
        )
        .bind(email)
        .fetch_one(&self.pool)
        .await
    }

    pub async fn delete_pending_by_email(&self, email: &str) -> Result<Vec<Uuid>, sqlx::Error> {
        let tokens: Vec<Uuid> = sqlx::query_scalar(
            r#"
            SELECT verification_token
            FROM flora_core.pending_registrations
            WHERE email = $1
            "#,
        )
        .bind(email)
        .fetch_all(&self.pool)
        .await?;
        if !tokens.is_empty() {
            sqlx::query("DELETE FROM flora_core.pending_registrations WHERE email = $1")
                .bind(email)
                .execute(&self.pool)
                .await?;
        }
        Ok(tokens)
    }

    pub async fn insert_pending(
        &self,
        verification_token: Uuid,
        email: &str,
        username: &str,
        password_hash: &str,
        expires_at: DateTime<Utc>,
        now: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.pending_registrations (
                verification_token, email, username, password_hash,
                expires_at, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $6)
            "#,
        )
        .bind(verification_token)
        .bind(email)
        .bind(username)
        .bind(password_hash)
        .bind(expires_at)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_pending(
        &self,
        verification_token: Uuid,
    ) -> Result<Option<PendingRegistrationRow>, sqlx::Error> {
        sqlx::query_as::<_, PendingRegistrationRow>(
            r#"
            SELECT verification_token, email, username, password_hash, expires_at
            FROM flora_core.pending_registrations
            WHERE verification_token = $1
            "#,
        )
        .bind(verification_token)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn delete_pending(&self, verification_token: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query(
            "DELETE FROM flora_core.pending_registrations WHERE verification_token = $1",
        )
        .bind(verification_token)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn insert_registered_account(
        &self,
        user_uuid: Uuid,
        email: &str,
        username: &str,
        phone: &str,
        password_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.user_accounts (
                user_uuid, username, phone, phone_verified, password_hash,
                email, email_verified, two_factor_enabled, status,
                last_login, services_mask, privacy_accepted, tos_accepted,
                has_social_network, has_email, services_count,
                created_at, updated_at
            ) VALUES (
                $1, $2, $3, false, $4,
                $5, true, false, 0,
                $6, 1, false, false,
                true, true, 1,
                $6, $6
            )
            "#,
        )
        .bind(user_uuid)
        .bind(username)
        .bind(phone)
        .bind(password_hash)
        .bind(email)
        .bind(now)
        .execute(&self.pool)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO flora_core.user_security_logs (
                user_uuid, password_updated_at, created_at, updated_at
            ) VALUES ($1, $2, $2, $2)
            "#,
        )
        .bind(user_uuid)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PendingRegistrationRow {
    pub verification_token: Uuid,
    pub email: String,
    pub username: String,
    pub password_hash: String,
    pub expires_at: DateTime<Utc>,
}
