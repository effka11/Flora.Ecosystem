//! sqlx-репозиторий Auth (`user_sessions`, `user_accounts`).

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

const STATUS_ACTIVE: i32 = 0;
/// `UserSessionStatus.RevokedPassword` — паритет с C#.
const STATUS_REVOKED_PASSWORD: i32 = 2;
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

    #[allow(clippy::too_many_arguments)] // mirrors user_sessions INSERT columns
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
        sqlx::query("DELETE FROM flora_core.pending_registrations WHERE verification_token = $1")
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

    pub async fn get_password_hash(&self, user_uuid: Uuid) -> Result<Option<String>, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT password_hash
            FROM flora_core.user_accounts
            WHERE user_uuid = $1
            "#,
        )
        .bind(user_uuid)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn update_password_hash(
        &self,
        user_uuid: Uuid,
        password_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE flora_core.user_accounts
            SET password_hash = $1, updated_at = $2
            WHERE user_uuid = $3
            "#,
        )
        .bind(password_hash)
        .bind(now)
        .bind(user_uuid)
        .execute(&self.pool)
        .await?;

        let updated = sqlx::query(
            r#"
            UPDATE flora_core.user_security_logs
            SET password_updated_at = $1, updated_at = $1
            WHERE user_uuid = $2
            "#,
        )
        .bind(now)
        .bind(user_uuid)
        .execute(&self.pool)
        .await?
        .rows_affected();

        if updated == 0 {
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
        }
        Ok(())
    }

    /// Отозвать прочие активные сессии после смены пароля (`RevokedPassword`).
    pub async fn revoke_other_sessions_for_password(
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
        .bind(STATUS_REVOKED_PASSWORD)
        .bind(user_uuid)
        .bind(STATUS_ACTIVE)
        .bind(now)
        .bind(current_jti)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    pub async fn delete_user_account(&self, user_uuid: Uuid) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            r#"
            DELETE FROM flora_core.user_accounts
            WHERE user_uuid = $1
            "#,
        )
        .bind(user_uuid)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    pub async fn get_security_account(
        &self,
        user_uuid: Uuid,
    ) -> Result<Option<SecurityAccountRow>, sqlx::Error> {
        sqlx::query_as::<_, SecurityAccountRow>(
            r#"
            SELECT password_hash, email, username, phone, phone_verified,
                   two_factor_enabled, two_factor_secret
            FROM flora_core.user_accounts
            WHERE user_uuid = $1
            "#,
        )
        .bind(user_uuid)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn email_taken_by_other(
        &self,
        email: &str,
        user_uuid: Uuid,
    ) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM flora_core.user_accounts
                WHERE email = $1 AND user_uuid <> $2
            )
            "#,
        )
        .bind(email)
        .bind(user_uuid)
        .fetch_one(&self.pool)
        .await
    }

    pub async fn phone_taken_by_other(
        &self,
        phone: &str,
        user_uuid: Uuid,
    ) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM flora_core.user_accounts
                WHERE phone = $1 AND user_uuid <> $2
            )
            "#,
        )
        .bind(phone)
        .bind(user_uuid)
        .fetch_one(&self.pool)
        .await
    }

    pub async fn update_account_email(
        &self,
        user_uuid: Uuid,
        email: &str,
        now: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE flora_core.user_accounts
            SET email = $1, has_email = true, email_verified = true, updated_at = $2
            WHERE user_uuid = $3
            "#,
        )
        .bind(email)
        .bind(now)
        .bind(user_uuid)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn update_account_phone(
        &self,
        user_uuid: Uuid,
        phone: &str,
        now: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE flora_core.user_accounts
            SET phone = $1, phone_verified = false, updated_at = $2
            WHERE user_uuid = $3
            "#,
        )
        .bind(phone)
        .bind(now)
        .bind(user_uuid)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_two_factor_secret(
        &self,
        user_uuid: Uuid,
        secret: &str,
        now: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE flora_core.user_accounts
            SET two_factor_secret = $1, two_factor_enabled = false, updated_at = $2
            WHERE user_uuid = $3
            "#,
        )
        .bind(secret)
        .bind(now)
        .bind(user_uuid)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn enable_two_factor(
        &self,
        user_uuid: Uuid,
        now: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE flora_core.user_accounts
            SET two_factor_enabled = true, updated_at = $1
            WHERE user_uuid = $2
            "#,
        )
        .bind(now)
        .bind(user_uuid)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn disable_two_factor(
        &self,
        user_uuid: Uuid,
        now: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE flora_core.user_accounts
            SET two_factor_enabled = false, two_factor_secret = NULL, updated_at = $1
            WHERE user_uuid = $2
            "#,
        )
        .bind(now)
        .bind(user_uuid)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_account_public(
        &self,
        user_uuid: Uuid,
    ) -> Result<Option<AccountPublicRow>, sqlx::Error> {
        sqlx::query_as::<_, AccountPublicRow>(
            r#"
            SELECT user_uuid, username, phone, email
            FROM flora_core.user_accounts
            WHERE user_uuid = $1
            "#,
        )
        .bind(user_uuid)
        .fetch_optional(&self.pool)
        .await
    }

    /// Паритет `AccountReadQueries.ListActiveUserUuidsAsync` (`UserAccountStatus.Active = 0`).
    pub async fn list_active_user_uuids(&self) -> Result<Vec<Uuid>, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT user_uuid
            FROM flora_core.user_accounts
            WHERE status = 0
            "#,
        )
        .fetch_all(&self.pool)
        .await
    }

    pub async fn find_uuid_by_username(&self, username: &str) -> Result<Option<Uuid>, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT user_uuid
            FROM flora_core.user_accounts
            WHERE username = $1
            "#,
        )
        .bind(username)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn usernames_by_uuids(
        &self,
        user_uuids: &[Uuid],
    ) -> Result<Vec<(Uuid, String)>, sqlx::Error> {
        if user_uuids.is_empty() {
            return Ok(Vec::new());
        }
        let rows = sqlx::query_as::<_, (Uuid, String)>(
            r#"
            SELECT user_uuid, username
            FROM flora_core.user_accounts
            WHERE user_uuid = ANY($1)
            "#,
        )
        .bind(user_uuids)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    pub async fn update_username(
        &self,
        user_uuid: Uuid,
        username: &str,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now();
        sqlx::query(
            r#"
            UPDATE flora_core.user_accounts
            SET username = $1, updated_at = $2
            WHERE user_uuid = $3
            "#,
        )
        .bind(username)
        .bind(now)
        .bind(user_uuid)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn username_taken_by_other(
        &self,
        username: &str,
        user_uuid: Uuid,
    ) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM flora_core.user_accounts
                WHERE username = $1 AND user_uuid <> $2
            )
            "#,
        )
        .bind(username)
        .bind(user_uuid)
        .fetch_one(&self.pool)
        .await
    }

    pub async fn search_accounts_by_username_contains(
        &self,
        exclude_user_uuid: Uuid,
        query_lower: &str,
    ) -> Result<Vec<(Uuid, String)>, sqlx::Error> {
        let pattern = format!("%{query_lower}%");
        sqlx::query_as(
            r#"
            SELECT user_uuid, username
            FROM flora_core.user_accounts
            WHERE user_uuid <> $1
              AND username IS NOT NULL
              AND LOWER(username) LIKE $2
            ORDER BY username
            "#,
        )
        .bind(exclude_user_uuid)
        .bind(pattern)
        .fetch_all(&self.pool)
        .await
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AccountPublicRow {
    pub user_uuid: Uuid,
    pub username: String,
    pub phone: String,
    pub email: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SecurityAccountRow {
    pub password_hash: String,
    pub email: Option<String>,
    pub username: String,
    pub phone: String,
    pub phone_verified: bool,
    pub two_factor_enabled: bool,
    pub two_factor_secret: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PendingRegistrationRow {
    pub verification_token: Uuid,
    pub email: String,
    pub username: String,
    pub password_hash: String,
    pub expires_at: DateTime<Utc>,
}
