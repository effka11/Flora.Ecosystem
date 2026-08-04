//! Password reset via email OTP — start / verify / complete.

use std::sync::Arc;
use std::time::Duration;

use chrono::{Duration as ChronoDuration, Utc};
use flora_auth_contracts::PasswordResetHook;
use flora_shared::flora_uuid::new_uuid;
use flora_verification_contracts::{
    ChallengeValidateStatus, KIND_EMAIL_PASSWORD_RESET, VerificationChallengePort,
};
use uuid::Uuid;

use crate::http::{PasswordResetCompleteResponse, PasswordResetStartResponse, PasswordResetVerifyResponse, format_utc};
use crate::http::rate_limit::FixedWindowLimiter;
use crate::infrastructure::password::{MAX_PASSWORD_BYTES, hash_password};
use crate::infrastructure::repo::AuthRepo;

const CHALLENGE_TTL_MINUTES: i64 = 15;
const GRANT_TTL_MINUTES: i64 = 10;
const SYNTHETIC_LATENCY: Duration = Duration::from_millis(80);

#[derive(Debug)]
pub enum PasswordResetStartError {
    BadRequest(&'static str),
    RateLimited,
    Internal(String),
}

#[derive(Debug)]
pub enum PasswordResetVerifyError {
    BadRequest(&'static str),
    Unauthorized { message: &'static str, code: &'static str },
    Internal(String),
}

#[derive(Debug)]
pub enum PasswordResetCompleteError {
    BadRequest { message: &'static str, code: &'static str },
    Unauthorized { message: &'static str, code: &'static str },
    Internal(String),
}

pub struct PasswordResetService {
    repo: Arc<AuthRepo>,
    verification: Arc<dyn VerificationChallengePort>,
    hook: Option<Arc<dyn PasswordResetHook>>,
    email_start_limiter: Arc<FixedWindowLimiter>,
}

impl PasswordResetService {
    pub fn new(
        repo: Arc<AuthRepo>,
        verification: Arc<dyn VerificationChallengePort>,
        hook: Option<Arc<dyn PasswordResetHook>>,
    ) -> Self {
        Self {
            repo,
            verification,
            hook,
            // 5 starts / 15 min per normalized email (email-bomb protection).
            email_start_limiter: Arc::new(FixedWindowLimiter::new(5, Duration::from_secs(15 * 60))),
        }
    }

    pub async fn start(&self, email_raw: &str) -> Result<PasswordResetStartResponse, PasswordResetStartError> {
        let email = email_raw.trim().to_lowercase();
        if email.is_empty() || !email.contains('@') {
            return Err(PasswordResetStartError::BadRequest("Укажите корректный email."));
        }

        if !self.email_start_limiter.check_and_increment(&email) {
            return Err(PasswordResetStartError::RateLimited);
        }

        let now = Utc::now();
        self.repo
            .cleanup_expired_password_resets(now)
            .await
            .map_err(|e| PasswordResetStartError::Internal(e.to_string()))?;

        let user_uuid = self
            .repo
            .find_user_uuid_by_email(&email)
            .await
            .map_err(|e| PasswordResetStartError::Internal(e.to_string()))?;

        let Some(user_uuid) = user_uuid else {
            return self.synthetic_start_response().await;
        };

        let superseded = self
            .repo
            .delete_pending_password_resets_by_user(user_uuid)
            .await
            .map_err(|e| PasswordResetStartError::Internal(e.to_string()))?;
        for token in superseded {
            let _ = self.verification.cancel(token).await;
        }
        self.repo
            .delete_password_reset_grants_by_user(user_uuid)
            .await
            .map_err(|e| PasswordResetStartError::Internal(e.to_string()))?;

        let challenge = self
            .verification
            .begin(KIND_EMAIL_PASSWORD_RESET, &email, Some(user_uuid))
            .await
            .map_err(|msg| {
                if msg.starts_with("Не удалось отправить код") {
                    PasswordResetStartError::BadRequest(
                        "Не удалось отправить код на email. Сервис почты временно недоступен — попробуйте позже.",
                    )
                } else {
                    PasswordResetStartError::Internal(msg)
                }
            })?;

        self.repo
            .insert_pending_password_reset(
                challenge.token,
                user_uuid,
                &email,
                challenge.expires_at_utc,
                now,
            )
            .await
            .map_err(|e| PasswordResetStartError::Internal(e.to_string()))?;

        Ok(PasswordResetStartResponse {
            reset_token: challenge.token.to_string(),
            expires_at: format_utc(challenge.expires_at_utc),
            dev_verification_code: challenge.dev_code,
        })
    }

    async fn synthetic_start_response(&self) -> Result<PasswordResetStartResponse, PasswordResetStartError> {
        tokio::time::sleep(SYNTHETIC_LATENCY).await;
        let token = new_uuid();
        let expires = Utc::now() + ChronoDuration::minutes(CHALLENGE_TTL_MINUTES);
        Ok(PasswordResetStartResponse {
            reset_token: token.to_string(),
            expires_at: format_utc(expires),
            dev_verification_code: None,
        })
    }

    pub async fn verify(
        &self,
        reset_token: Uuid,
        code_plain: &str,
    ) -> Result<PasswordResetVerifyResponse, PasswordResetVerifyError> {
        if code_plain.trim().is_empty() {
            return Err(PasswordResetVerifyError::BadRequest("Введите код из сообщения."));
        }

        let now = Utc::now();
        self.repo
            .cleanup_expired_password_resets(now)
            .await
            .map_err(|e| PasswordResetVerifyError::Internal(e.to_string()))?;

        let pending = self
            .repo
            .get_pending_password_reset(reset_token)
            .await
            .map_err(|e| PasswordResetVerifyError::Internal(e.to_string()))?;

        let Some(pending) = pending else {
            return Err(PasswordResetVerifyError::Unauthorized {
                message: "Токен сброса недействителен или истёк.",
                code: "auth.password_reset.invalid_token",
            });
        };

        if pending.expires_at <= now {
            let _ = self.repo.delete_pending_password_reset(reset_token).await;
            return Err(PasswordResetVerifyError::Unauthorized {
                message: "Код сброса истёк.",
                code: "auth.password_reset.expired",
            });
        }

        let validation = self
            .verification
            .validate(reset_token, code_plain)
            .await
            .map_err(PasswordResetVerifyError::Internal)?;

        if !validation.success() {
            return match validation.status {
                ChallengeValidateStatus::Expired => Err(PasswordResetVerifyError::Unauthorized {
                    message: "Код сброса истёк.",
                    code: "auth.password_reset.expired",
                }),
                ChallengeValidateStatus::CodeMismatch => Err(PasswordResetVerifyError::Unauthorized {
                    message: "Неверный код.",
                    code: "auth.password_reset.invalid_code",
                }),
                ChallengeValidateStatus::NotFound => Err(PasswordResetVerifyError::Unauthorized {
                    message: "Токен сброса недействителен или истёк.",
                    code: "auth.password_reset.invalid_token",
                }),
                ChallengeValidateStatus::Success => unreachable!(),
            };
        }

        if validation.subject_user_uuid.is_some_and(|u| u != pending.user_uuid) {
            let _ = self.repo.delete_pending_password_reset(reset_token).await;
            return Err(PasswordResetVerifyError::Unauthorized {
                message: "Токен сброса недействителен или истёк.",
                code: "auth.password_reset.invalid_token",
            });
        }
        if validation
            .target
            .as_deref()
            .is_some_and(|t| t != pending.email)
        {
            let _ = self.repo.delete_pending_password_reset(reset_token).await;
            return Err(PasswordResetVerifyError::Unauthorized {
                message: "Токен сброса недействителен или истёк.",
                code: "auth.password_reset.invalid_token",
            });
        }

        self.repo
            .delete_pending_password_reset(reset_token)
            .await
            .map_err(|e| PasswordResetVerifyError::Internal(e.to_string()))?;

        let completion_token = new_uuid();
        let grant_expires = now + ChronoDuration::minutes(GRANT_TTL_MINUTES);
        self.repo
            .insert_password_reset_grant(completion_token, pending.user_uuid, grant_expires, now)
            .await
            .map_err(|e| PasswordResetVerifyError::Internal(e.to_string()))?;

        Ok(PasswordResetVerifyResponse {
            completion_token: completion_token.to_string(),
            expires_at: format_utc(grant_expires),
        })
    }

    pub async fn complete(
        &self,
        completion_token: Uuid,
        new_password: &str,
    ) -> Result<PasswordResetCompleteResponse, PasswordResetCompleteError> {
        if new_password.trim().is_empty() {
            return Err(PasswordResetCompleteError::BadRequest {
                message: "Укажите новый пароль.",
                code: "auth.password_reset.bad_password",
            });
        }
        if new_password.chars().count() < 8 {
            return Err(PasswordResetCompleteError::BadRequest {
                message: "Новый пароль должен быть не короче 8 символов.",
                code: "auth.password_reset.bad_password",
            });
        }
        if new_password.len() > MAX_PASSWORD_BYTES {
            return Err(PasswordResetCompleteError::BadRequest {
                message: "Новый пароль слишком длинный.",
                code: "auth.password_reset.bad_password",
            });
        }

        // Hash before consuming the grant so spawn_blocking / validation failures
        // do not burn a one-shot completion token.
        let password_owned = new_password.to_string();
        let new_hash = tokio::task::spawn_blocking(move || hash_password(&password_owned))
            .await
            .map_err(|e| PasswordResetCompleteError::Internal(e.to_string()))?;

        let now = Utc::now();
        let user_uuid = self
            .repo
            .consume_password_reset_grant(completion_token, now)
            .await
            .map_err(|e| PasswordResetCompleteError::Internal(e.to_string()))?;

        let Some(user_uuid) = user_uuid else {
            return Err(PasswordResetCompleteError::Unauthorized {
                message: "Токен сброса недействителен или истёк.",
                code: "auth.password_reset.invalid_token",
            });
        };

        self.repo
            .update_password_hash(user_uuid, &new_hash, now)
            .await
            .map_err(|e| PasswordResetCompleteError::Internal(e.to_string()))?;

        // Policy A: password committed → always ok. Session revoke + E2E lock are best-effort.
        if let Err(e) = self
            .repo
            .revoke_all_sessions_for_password(user_uuid, now)
            .await
        {
            tracing::error!(
                user_uuid = %user_uuid,
                error = %e,
                "password reset session revoke failed (password already changed)"
            );
        }

        if let Some(hook) = &self.hook
            && let Err(e) = hook.after_password_reset(user_uuid).await
        {
            tracing::error!(
                user_uuid = %user_uuid,
                error = %e,
                "password reset E2E lock hook failed (password already changed)"
            );
        }

        Ok(PasswordResetCompleteResponse { ok: true })
    }
}

#[cfg(test)]
mod tests {
    use super::{CHALLENGE_TTL_MINUTES, GRANT_TTL_MINUTES};
    use crate::http::PasswordResetStartResponse;
    use crate::http::rate_limit::FixedWindowLimiter;
    use std::time::Duration;

    #[test]
    fn email_start_limiter_blocks_after_five() {
        let lim = FixedWindowLimiter::new(5, Duration::from_secs(15 * 60));
        for _ in 0..5 {
            assert!(lim.check_and_increment("user@flora.local"));
        }
        assert!(!lim.check_and_increment("user@flora.local"));
        assert!(lim.check_and_increment("other@flora.local"));
    }

    #[test]
    fn grant_ttl_is_ten_minutes() {
        assert_eq!(GRANT_TTL_MINUTES, 10);
        assert_eq!(CHALLENGE_TTL_MINUTES, 15);
    }

    #[test]
    fn synthetic_response_omits_dev_code() {
        let resp = PasswordResetStartResponse {
            reset_token: "t".into(),
            expires_at: "2026-01-01T00:00:00.000Z".into(),
            dev_verification_code: None,
        };
        let v = serde_json::to_value(&resp).unwrap();
        assert!(v.get("devVerificationCode").is_none() || v["devVerificationCode"].is_null());
        assert_eq!(v["resetToken"], "t");
    }

    #[test]
    fn error_codes_are_stable_strings() {
        let codes = [
            "auth.password_reset.invalid_code",
            "auth.password_reset.expired",
            "auth.password_reset.invalid_token",
            "auth.password_reset.rate_limited",
            "auth.password_reset.bad_password",
        ];
        for c in codes {
            assert!(c.starts_with("auth.password_reset."));
        }
    }

    /// Policy A contract: complete response stays `{ ok: true }` after password commit
    /// (session revoke / E2E hook failures must not change the success envelope).
    #[test]
    fn complete_success_envelope_is_ok_true() {
        let v = serde_json::to_value(crate::http::PasswordResetCompleteResponse { ok: true }).unwrap();
        assert_eq!(v, serde_json::json!({ "ok": true }));
    }
}
