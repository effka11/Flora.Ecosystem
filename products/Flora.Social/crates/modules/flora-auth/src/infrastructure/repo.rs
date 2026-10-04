//! sqlx-репозиторий Auth (`user_sessions`, `user_accounts`).

use chrono::{DateTime, Duration, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::refresh_machine::{RefreshDecision, ReplayRecord, SessionState, decide};
use crate::infrastructure::tokens::hash_refresh_token;

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

    pub async fn is_active_session(
        &self,
        user_uuid: Uuid,
        jwt_id: &str,
        now: DateTime<Utc>,
    ) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM flora_core.user_sessions
                WHERE user_uuid = $1
                  AND jwt_id = $2
                  AND status = $3
                  AND expires_at > $4
            )
            "#,
        )
        .bind(user_uuid)
        .bind(jwt_id)
        .bind(STATUS_ACTIVE)
        .bind(now)
        .fetch_one(&self.pool)
        .await
    }

    /// Разрешить стабильный `session_id` активной сессии по `jwt_id` (JTI).
    ///
    /// Middleware вызывает это на каждый защищённый запрос: пока access-токен
    /// валиден, его JTI совпадает с текущим `jwt_id` строки. Полученный
    /// `session_id` кладётся в `AuthUser`, поэтому logout/revoke оперируют по
    /// session id и не зависят от параллельной ротации JTI.
    pub async fn find_active_session_id_by_jwt(
        &self,
        user_uuid: Uuid,
        jwt_id: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<Uuid>, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT session_id
            FROM flora_core.user_sessions
            WHERE user_uuid = $1
              AND jwt_id = $2
              AND status = $3
              AND expires_at > $4
            "#,
        )
        .bind(user_uuid)
        .bind(jwt_id)
        .bind(STATUS_ACTIVE)
        .bind(now)
        .fetch_optional(&self.pool)
        .await
    }

    /// Logout текущей сессии по стабильному `session_id` (без фильтра по status —
    /// паритет прежнего `revoke_by_jwt_id`). Идемпотентно; повторный logout no-op.
    pub async fn revoke_by_session_id_logout(&self, session_id: Uuid) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            r#"
            UPDATE flora_core.user_sessions
            SET status = $1
            WHERE session_id = $2
            "#,
        )
        .bind(STATUS_REVOKED_USER)
        .bind(session_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    /// Завершить все активные сессии пользователя, кроме текущей (по `session_id`).
    /// Если `current_session_id` = NULL — отзываются все активные.
    pub async fn revoke_other_sessions_except_id(
        &self,
        user_uuid: Uuid,
        current_session_id: Option<Uuid>,
        now: DateTime<Utc>,
    ) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            r#"
            UPDATE flora_core.user_sessions
            SET status = $1
            WHERE user_uuid = $2
              AND status = $3
              AND expires_at > $4
              AND ($5::uuid IS NULL OR session_id <> $5)
            "#,
        )
        .bind(STATUS_REVOKED_USER)
        .bind(user_uuid)
        .bind(STATUS_ACTIVE)
        .bind(now)
        .bind(current_session_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
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
        let refresh_hash = hash_refresh_token(refresh_token);
        sqlx::query_as::<_, RefreshSessionRow>(
            r#"
            SELECT session_id, user_uuid, rotation_id
            FROM flora_core.user_sessions
            WHERE (
                    refresh_token = $1
                    OR (refresh_token = $2 AND refresh_token NOT LIKE 'sha256:%')
                  )
              AND status = $3
              AND expires_at > $4
            "#,
        )
        .bind(refresh_hash)
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

    #[allow(clippy::too_many_arguments)] // atomic rotation + reuse detection fields
    pub async fn rotate_session(
        &self,
        session_id: Uuid,
        expected_refresh_token: &str,
        expected_rotation_id: i64,
        new_jwt_id: &str,
        new_refresh_token: &str,
        expires_at: DateTime<Utc>,
        last_activity: DateTime<Utc>,
        new_rotation_id: i64,
    ) -> Result<bool, sqlx::Error> {
        let expected_refresh_hash = hash_refresh_token(expected_refresh_token);
        let new_refresh_hash = hash_refresh_token(new_refresh_token);
        let result = sqlx::query(
            r#"
            UPDATE flora_core.user_sessions
            SET jwt_id = $1,
                refresh_token = $2,
                expires_at = $3,
                last_activity = $4,
                rotation_id = $5
            WHERE session_id = $6
              AND rotation_id = $7
              AND status = $8
              AND (
                    refresh_token = $9
                    OR (refresh_token = $10 AND refresh_token NOT LIKE 'sha256:%')
                  )
            "#,
        )
        .bind(new_jwt_id)
        .bind(new_refresh_hash)
        .bind(expires_at)
        .bind(last_activity)
        .bind(new_rotation_id)
        .bind(session_id)
        .bind(expected_rotation_id)
        .bind(STATUS_ACTIVE)
        .bind(expected_refresh_hash)
        .bind(expected_refresh_token)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Prefetch (без row lock) для сборки прогнозного R2 до транзакции:
    /// `user_uuid` + `rotation_id` по `session_id`, независимо от статуса.
    pub async fn find_refresh_session_by_id(
        &self,
        session_id: Uuid,
    ) -> Result<Option<RefreshSessionRow>, sqlx::Error> {
        sqlx::query_as::<_, RefreshSessionRow>(
            r#"
            SELECT session_id, user_uuid, rotation_id
            FROM flora_core.user_sessions
            WHERE session_id = $1
            "#,
        )
        .bind(session_id)
        .fetch_optional(&self.pool)
        .await
    }

    /// Fallback для legacy-токена без крипто-привязки к family: найти `session_id`
    /// активной сессии по refresh hash/raw. Возвращает только id (не отзыв-oracle).
    pub async fn find_session_id_by_refresh(
        &self,
        refresh_token: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<Uuid>, sqlx::Error> {
        let refresh_hash = hash_refresh_token(refresh_token);
        sqlx::query_scalar(
            r#"
            SELECT session_id
            FROM flora_core.user_sessions
            WHERE (
                    refresh_token = $1
                    OR (refresh_token = $2 AND refresh_token NOT LIKE 'sha256:%')
                  )
              AND status = $3
              AND expires_at > $4
            "#,
        )
        .bind(refresh_hash)
        .bind(refresh_token)
        .bind(STATUS_ACTIVE)
        .bind(now)
        .fetch_optional(&self.pool)
        .await
    }

    /// Транзакционная replay-safe state machine (plan §2).
    ///
    /// `READ COMMITTED`; первой блокируется строка `user_sessions` (`FOR UPDATE`),
    /// затем по `clock_timestamp()` перепроверяются статус/expiry/hash. Решение —
    /// единый [`decide`] (тот же, что покрыт unit-тестами). Rotate меняет сессию и
    /// upsert-ит replay-строку одним commit; Replay читает сохранённый grant;
    /// ReuseOutsideGrace отзывает сессию; Invalid ничего не пишет.
    #[allow(clippy::too_many_arguments)] // atomic rotation state machine + drain flag
    pub async fn rotate_or_replay(
        &self,
        session_id: Uuid,
        presented_raw: &str,
        presented_hash: &str,
        bound: bool,
        grant: &PreparedGrant,
        grace_seconds: i64,
        draining: bool,
    ) -> Result<RefreshOutcome, sqlx::Error> {
        let mut tx = self.pool.begin().await?;

        let locked: Option<LockedSessionRow> = sqlx::query_as(
            r#"
            SELECT status, expires_at, refresh_token, rotation_id, user_uuid,
                   clock_timestamp() AS db_now
            FROM flora_core.user_sessions
            WHERE session_id = $1
            FOR UPDATE
            "#,
        )
        .bind(session_id)
        .fetch_optional(&mut *tx)
        .await?;

        let Some(locked) = locked else {
            tx.rollback().await?;
            return Ok(RefreshOutcome::Invalid);
        };

        let replay_row: Option<ReplayDbRow> = sqlx::query_as(
            r#"
            SELECT spent_hash, replacement_hash, replacement_rotation_id, refresh_expires_at,
                   valid_until, key_id, nonce, ciphertext, version
            FROM flora_core.auth_refresh_replays
            WHERE session_id = $1
            "#,
        )
        .bind(session_id)
        .fetch_optional(&mut *tx)
        .await?;

        // Legacy-строка хранит сырой refresh (не `sha256:`-hash): текущим считаем
        // и hash-совпадение, и сырое совпадение для не-hashed строк.
        let presented_is_current = locked.refresh_token == presented_hash
            || (locked.refresh_token == presented_raw
                && !locked.refresh_token.starts_with("sha256:"));

        let session_state = SessionState {
            active: locked.status == STATUS_ACTIVE,
            expires_at: locked.expires_at,
            stored_hash: locked.refresh_token.clone(),
            rotation_id: locked.rotation_id,
        };
        let replay_record = replay_row.as_ref().map(|row| ReplayRecord {
            spent_hash: row.spent_hash.clone(),
            replacement_hash: row.replacement_hash.clone(),
            valid_until: row.valid_until,
        });

        let decision = decide(
            Some(&session_state),
            replay_record.as_ref(),
            presented_hash,
            presented_is_current,
            bound,
            locked.db_now,
        );

        // Drain-режим (rollback): любое решение, которое создало бы новую ротацию
        // или отозвало бы family, блокируется БЕЗ мутации строки → 503. Replay в
        // grace и Invalid проходят как обычно (Replay обслуживается, Invalid = 401,
        // ни один не мутирует статус в false-revoke).
        if crate::domain::refresh_machine::drain_blocks(decision, draining) {
            tx.rollback().await?;
            return Ok(RefreshOutcome::Draining);
        }

        match decision {
            RefreshDecision::Rotate => {
                let valid_until = locked.db_now + Duration::seconds(grace_seconds);
                let updated = sqlx::query(
                    r#"
                    UPDATE flora_core.user_sessions
                    SET jwt_id = $1,
                        refresh_token = $2,
                        expires_at = $3,
                        last_activity = $4,
                        rotation_id = $5
                    WHERE session_id = $6
                      AND rotation_id = $7
                      AND status = $8
                    "#,
                )
                .bind(&grant.new_jwt_id)
                .bind(&grant.new_refresh_hash)
                .bind(grant.refresh_expires_at)
                .bind(locked.db_now)
                .bind(grant.new_rotation_id)
                .bind(session_id)
                .bind(grant.expected_rotation_id)
                .bind(STATUS_ACTIVE)
                .execute(&mut *tx)
                .await?
                .rows_affected();
                if updated != 1 {
                    // Под row lock не должно случаться; трактуем как concurrency-аномалию
                    // → transient 5xx (retry R1 восстановит R2).
                    tx.rollback().await?;
                    return Err(sqlx::Error::RowNotFound);
                }
                sqlx::query(
                    r#"
                    INSERT INTO flora_core.auth_refresh_replays (
                        session_id, spent_hash, replacement_hash, replacement_rotation_id,
                        refresh_expires_at, valid_until, key_id, nonce, ciphertext, version,
                        created_at, updated_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
                    ON CONFLICT (session_id) DO UPDATE SET
                        spent_hash = EXCLUDED.spent_hash,
                        replacement_hash = EXCLUDED.replacement_hash,
                        replacement_rotation_id = EXCLUDED.replacement_rotation_id,
                        refresh_expires_at = EXCLUDED.refresh_expires_at,
                        valid_until = EXCLUDED.valid_until,
                        key_id = EXCLUDED.key_id,
                        nonce = EXCLUDED.nonce,
                        ciphertext = EXCLUDED.ciphertext,
                        version = EXCLUDED.version,
                        updated_at = EXCLUDED.updated_at
                    "#,
                )
                .bind(session_id)
                .bind(&grant.spent_hash)
                .bind(&grant.new_refresh_hash)
                .bind(grant.new_rotation_id)
                .bind(grant.refresh_expires_at)
                .bind(valid_until)
                .bind(&grant.key_id)
                .bind(&grant.nonce)
                .bind(&grant.ciphertext)
                .bind(grant.version)
                .bind(locked.db_now)
                .execute(&mut *tx)
                .await?;
                tx.commit().await?;
                Ok(RefreshOutcome::Rotated {
                    user_uuid: locked.user_uuid,
                })
            }
            RefreshDecision::Replay => {
                let row = replay_row.expect("Replay требует наличия replay-строки");
                tx.commit().await?;
                Ok(RefreshOutcome::Replayed(StoredGrant {
                    session_id,
                    spent_hash: row.spent_hash,
                    replacement_hash: row.replacement_hash,
                    replacement_rotation_id: row.replacement_rotation_id,
                    refresh_expires_at: row.refresh_expires_at,
                    key_id: row.key_id,
                    nonce: row.nonce,
                    ciphertext: row.ciphertext,
                    version: row.version,
                }))
            }
            RefreshDecision::ReuseOutsideGrace => {
                sqlx::query(
                    r#"
                    UPDATE flora_core.user_sessions
                    SET status = $1
                    WHERE session_id = $2
                      AND status = $3
                    "#,
                )
                .bind(STATUS_REVOKED_USER)
                .bind(session_id)
                .bind(STATUS_ACTIVE)
                .execute(&mut *tx)
                .await?;
                tx.commit().await?;
                Ok(RefreshOutcome::ReusedOutsideGrace)
            }
            RefreshDecision::Invalid => {
                tx.rollback().await?;
                Ok(RefreshOutcome::Invalid)
            }
        }
    }

    /// Auth-owned bounded cleanup: пакетно удалить истёкшие replay-строки по индексу
    /// `valid_until`. Возвращает число удалённых строк.
    pub async fn cleanup_expired_replays(
        &self,
        now: DateTime<Utc>,
        batch_limit: i64,
    ) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            r#"
            DELETE FROM flora_core.auth_refresh_replays
            WHERE session_id IN (
                SELECT session_id
                FROM flora_core.auth_refresh_replays
                WHERE valid_until <= $1
                ORDER BY valid_until
                LIMIT $2
            )
            "#,
        )
        .bind(now)
        .bind(batch_limit)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    pub async fn revoke_session_by_id(&self, session_id: Uuid) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            r#"
            UPDATE flora_core.user_sessions
            SET status = $1
            WHERE session_id = $2
              AND status = $3
            "#,
        )
        .bind(STATUS_REVOKED_USER)
        .bind(session_id)
        .bind(STATUS_ACTIVE)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
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

    pub async fn record_login_failure(
        &self,
        user_uuid: Uuid,
        now: DateTime<Utc>,
        max_failures: i16,
        locked_until: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.user_security_logs AS security_log (
                user_uuid, password_updated_at, login_failures, login_locked_until,
                created_at, updated_at
            ) VALUES ($1, $2, 1, NULL, $2, $2)
            ON CONFLICT (user_uuid) DO UPDATE SET
                login_failures = CASE
                    WHEN security_log.login_locked_until > $2
                        THEN security_log.login_failures
                    WHEN security_log.login_failures + 1 >= $3
                        THEN 0
                    ELSE security_log.login_failures + 1
                END,
                login_locked_until = CASE
                    WHEN security_log.login_locked_until > $2
                        THEN security_log.login_locked_until
                    WHEN security_log.login_failures + 1 >= $3
                        THEN $4
                    ELSE NULL
                END,
                updated_at = $2
            "#,
        )
        .bind(user_uuid)
        .bind(now)
        .bind(max_failures)
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
        .bind(hash_refresh_token(refresh_token))
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

    /// Отозвать прочие активные сессии после смены пароля по стабильному
    /// `session_id` (`RevokedPassword`). Текущая сессия (`keep_session_id`) не
    /// отзывается независимо от параллельной ротации её JTI.
    pub async fn revoke_other_sessions_for_password_except_id(
        &self,
        user_uuid: Uuid,
        keep_session_id: Option<Uuid>,
        now: DateTime<Utc>,
    ) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            r#"
            UPDATE flora_core.user_sessions
            SET status = $1
            WHERE user_uuid = $2
              AND status = $3
              AND expires_at > $4
              AND ($5::uuid IS NULL OR session_id <> $5)
            "#,
        )
        .bind(STATUS_REVOKED_PASSWORD)
        .bind(user_uuid)
        .bind(STATUS_ACTIVE)
        .bind(now)
        .bind(keep_session_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
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
        // Case-insensitive: legacy rows may still have mixed case until migrated.
        sqlx::query_scalar(
            r#"
            SELECT user_uuid
            FROM flora_core.user_accounts
            WHERE LOWER(username) = LOWER($1)
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
                WHERE LOWER(username) = LOWER($1) AND user_uuid <> $2
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

/// Прогнозный R2 (собран приложением ДО транзакции, вне row lock) для записи при
/// Rotate. `spent_hash` — hash поданного R1; `new_refresh_hash` становится
/// `replacement_hash` replay-строки.
#[derive(Debug, Clone)]
pub struct PreparedGrant {
    pub expected_rotation_id: i64,
    pub new_rotation_id: i64,
    pub new_jwt_id: String,
    pub new_refresh_hash: String,
    pub refresh_expires_at: DateTime<Utc>,
    pub spent_hash: String,
    pub key_id: String,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub version: i32,
}

/// Сохранённый grant, возвращаемый при Replay: приложение восстанавливает AAD и
/// расшифровывает ciphertext key ring'ом.
#[derive(Debug, Clone)]
pub struct StoredGrant {
    pub session_id: Uuid,
    pub spent_hash: String,
    pub replacement_hash: String,
    pub replacement_rotation_id: i64,
    pub refresh_expires_at: DateTime<Utc>,
    pub key_id: String,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub version: i32,
}

/// Типизированный итог retry-safe refresh (plan §1: `Rotated | Replayed |
/// ReusedOutsideGrace | Invalid`).
#[derive(Debug)]
pub enum RefreshOutcome {
    Rotated {
        user_uuid: Uuid,
    },
    Replayed(StoredGrant),
    ReusedOutsideGrace,
    Invalid,
    /// Drain-режим (rollback): решение потребовало бы новую ротацию (или отзыв по
    /// reuse), но инстанс дренируется. Строка НЕ мутируется — вызывающий отдаёт
    /// 503 (retryable). Replay внутри grace продолжает обслуживаться.
    Draining,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct LockedSessionRow {
    status: i32,
    expires_at: DateTime<Utc>,
    refresh_token: String,
    rotation_id: i64,
    user_uuid: Uuid,
    db_now: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct ReplayDbRow {
    spent_hash: String,
    replacement_hash: String,
    replacement_rotation_id: i64,
    refresh_expires_at: DateTime<Utc>,
    valid_until: DateTime<Utc>,
    key_id: String,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
    version: i32,
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

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PendingPasswordResetRow {
    pub reset_token: Uuid,
    pub user_uuid: Uuid,
    pub email: String,
    pub expires_at: DateTime<Utc>,
}

impl AuthRepo {
    pub async fn find_user_uuid_by_email(&self, email: &str) -> Result<Option<Uuid>, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            SELECT user_uuid
            FROM flora_core.user_accounts
            WHERE email = $1
            "#,
        )
        .bind(email)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn cleanup_expired_password_resets(
        &self,
        now: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM flora_core.pending_password_resets WHERE expires_at <= $1")
            .bind(now)
            .execute(&self.pool)
            .await?;
        sqlx::query("DELETE FROM flora_core.password_reset_grants WHERE expires_at <= $1")
            .bind(now)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn delete_pending_password_resets_by_user(
        &self,
        user_uuid: Uuid,
    ) -> Result<Vec<Uuid>, sqlx::Error> {
        let tokens: Vec<Uuid> = sqlx::query_scalar(
            r#"
            SELECT reset_token
            FROM flora_core.pending_password_resets
            WHERE user_uuid = $1
            "#,
        )
        .bind(user_uuid)
        .fetch_all(&self.pool)
        .await?;
        if !tokens.is_empty() {
            sqlx::query("DELETE FROM flora_core.pending_password_resets WHERE user_uuid = $1")
                .bind(user_uuid)
                .execute(&self.pool)
                .await?;
        }
        Ok(tokens)
    }

    pub async fn delete_password_reset_grants_by_user(
        &self,
        user_uuid: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM flora_core.password_reset_grants WHERE user_uuid = $1")
            .bind(user_uuid)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn insert_pending_password_reset(
        &self,
        reset_token: Uuid,
        user_uuid: Uuid,
        email: &str,
        expires_at: DateTime<Utc>,
        now: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.pending_password_resets (
                reset_token, user_uuid, email, expires_at, created_at
            ) VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(reset_token)
        .bind(user_uuid)
        .bind(email)
        .bind(expires_at)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_pending_password_reset(
        &self,
        reset_token: Uuid,
    ) -> Result<Option<PendingPasswordResetRow>, sqlx::Error> {
        sqlx::query_as::<_, PendingPasswordResetRow>(
            r#"
            SELECT reset_token, user_uuid, email, expires_at
            FROM flora_core.pending_password_resets
            WHERE reset_token = $1
            "#,
        )
        .bind(reset_token)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn delete_pending_password_reset(
        &self,
        reset_token: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM flora_core.pending_password_resets WHERE reset_token = $1")
            .bind(reset_token)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn insert_password_reset_grant(
        &self,
        completion_token: Uuid,
        user_uuid: Uuid,
        expires_at: DateTime<Utc>,
        now: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO flora_core.password_reset_grants (
                completion_token, user_uuid, expires_at, created_at
            ) VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(completion_token)
        .bind(user_uuid)
        .bind(expires_at)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Atomically consume a grant. Returns user_uuid if consumed.
    pub async fn consume_password_reset_grant(
        &self,
        completion_token: Uuid,
        now: DateTime<Utc>,
    ) -> Result<Option<Uuid>, sqlx::Error> {
        sqlx::query_scalar(
            r#"
            DELETE FROM flora_core.password_reset_grants
            WHERE completion_token = $1
              AND expires_at > $2
            RETURNING user_uuid
            "#,
        )
        .bind(completion_token)
        .bind(now)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn revoke_all_sessions_for_password(
        &self,
        user_uuid: Uuid,
        now: DateTime<Utc>,
    ) -> Result<u64, sqlx::Error> {
        self.revoke_other_sessions_for_password_except_id(user_uuid, None, now)
            .await
    }
}
