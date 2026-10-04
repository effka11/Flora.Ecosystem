use std::sync::Arc;

use chrono::{Duration, Utc};
use flora_users_contracts::UserProfileReadQueries;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::http::{LoginResponse, TwoFactorChallengeResponse, format_utc};
use crate::infrastructure::jwt::{AccessTokenClaims, JwtOptions, issue_access_token};
use crate::infrastructure::password::verify_password;
use crate::infrastructure::repo::AuthRepo;
use crate::infrastructure::tokens::{
    generate_csrf_token, generate_hmac_key, generate_jwt_id, generate_refresh_token,
};
use crate::infrastructure::totp::verify_totp;

const MAX_LOGIN_FAILURES: u8 = 5;
const LOCKOUT_MINUTES: i64 = 15;
/// Валидный Argon2id-хеш для выравнивания стоимости входа с неизвестным identifier.
/// Значение публичное и не соответствует реальному аккаунту.
const DUMMY_PASSWORD_HASH: &str =
    "8OHSw7Sllod4aVpLPC0eD0W2OWZGOzFd9mmPwRicJvM8XHz2Y/DIKgTVA6aqL/Hc";

pub struct SessionHints {
    pub ip: String,
    pub agent_hash: String,
}

#[derive(Debug)]
pub enum LoginError {
    BadRequest(&'static str),
    Unauthorized(String),
    TwoFactor(TwoFactorChallengeResponse),
    Internal(String),
}

pub struct LoginService {
    repo: Arc<AuthRepo>,
    jwt: JwtOptions,
    profiles: Arc<dyn UserProfileReadQueries>,
}

impl LoginService {
    pub fn new(
        repo: Arc<AuthRepo>,
        jwt: JwtOptions,
        profiles: Arc<dyn UserProfileReadQueries>,
    ) -> Self {
        Self {
            repo,
            jwt,
            profiles,
        }
    }

    pub async fn login(
        &self,
        email: Option<&str>,
        phone: Option<&str>,
        password: &str,
        two_factor_code: Option<&str>,
        hints: SessionHints,
    ) -> Result<LoginResponse, LoginError> {
        if password.trim().is_empty() {
            return Err(LoginError::BadRequest("Пароль обязателен."));
        }
        let identifier = resolve_identifier(email, phone);
        if identifier.is_empty() {
            return Err(LoginError::BadRequest("Укажите email."));
        }

        let now = Utc::now();
        let _ = self
            .repo
            .cleanup_expired_pending(now)
            .await
            .map_err(|e| LoginError::Internal(e.to_string()))?;

        let user = self
            .repo
            .find_active_account_by_identifier(&identifier)
            .await
            .map_err(|e| LoginError::Internal(e.to_string()))?;

        let Some(user) = user else {
            let password_owned = password.to_string();
            tokio::task::spawn_blocking(move || {
                verify_password(&password_owned, DUMMY_PASSWORD_HASH)
            })
            .await
            .map_err(|e| LoginError::Internal(e.to_string()))?;
            return Err(LoginError::Unauthorized(
                "Неверный email или пароль.".into(),
            ));
        };

        let security = self
            .repo
            .get_security_log(user.user_uuid)
            .await
            .map_err(|e| LoginError::Internal(e.to_string()))?;

        if let Some(ref sec) = security
            && let Some(locked) = sec.login_locked_until
            && locked > now
        {
            return Err(LoginError::Unauthorized(
                "Слишком много неудачных попыток входа. Повторите попытку позже.".into(),
            ));
        }

        let password_hash = user.password_hash.clone();
        let password_owned = password.to_string();
        let ok =
            tokio::task::spawn_blocking(move || verify_password(&password_owned, &password_hash))
                .await
                .map_err(|e| LoginError::Internal(e.to_string()))?;

        if !ok {
            self.register_failure(user.user_uuid, now).await?;
            return Err(LoginError::Unauthorized(
                "Неверный email или пароль.".into(),
            ));
        }

        if user.two_factor_enabled {
            let code = two_factor_code.unwrap_or("").trim();
            if code.is_empty() {
                return Err(LoginError::TwoFactor(TwoFactorChallengeResponse {
                    requires_two_factor: true,
                    error: None,
                }));
            }
            if !verify_totp(user.two_factor_secret.as_deref(), code) {
                self.register_failure(user.user_uuid, now).await?;
                return Err(LoginError::TwoFactor(TwoFactorChallengeResponse {
                    requires_two_factor: true,
                    error: Some("Неверный код двухфакторной аутентификации.".into()),
                }));
            }
        }

        let jwt_id = generate_jwt_id();
        let session_id = Uuid::now_v7();
        let refresh_token = generate_refresh_token(session_id, self.jwt.secret.as_bytes());
        let access_expires = now + Duration::minutes(self.jwt.access_token_minutes);
        let refresh_expires = now + Duration::days(self.jwt.refresh_token_days);
        let csrf = generate_csrf_token();
        let hmac_key = generate_hmac_key();

        self.repo
            .insert_session(
                session_id,
                user.user_uuid,
                &hints.agent_hash,
                &hints.ip,
                refresh_expires,
                now,
                &jwt_id,
                &refresh_token,
                &csrf,
                &hmac_key,
            )
            .await
            .map_err(|e| LoginError::Internal(e.to_string()))?;

        self.repo
            .touch_account_last_login(user.user_uuid, now)
            .await
            .map_err(|e| LoginError::Internal(e.to_string()))?;

        if security.is_some() {
            self.repo
                .clear_login_failures_on_success(user.user_uuid, now)
                .await
                .map_err(|e| LoginError::Internal(e.to_string()))?;
        }

        let token_identifier = user
            .email
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| user.phone.clone());

        let access_token = issue_access_token(
            &self.jwt,
            &AccessTokenClaims {
                sub: user.user_uuid.to_string(),
                email: token_identifier,
                jti: jwt_id,
                expires_at: access_expires.timestamp(),
            },
        );

        let requires_profile = self
            .profiles
            .requires_profile_completion(user.user_uuid)
            .await
            .map_err(LoginError::Internal)?;

        Ok(LoginResponse {
            access_token,
            refresh_token,
            expires_at: format_utc(access_expires),
            token_type: "Bearer".into(),
            requires_profile_completion: requires_profile,
        })
    }

    async fn register_failure(
        &self,
        user_uuid: Uuid,
        now: chrono::DateTime<Utc>,
    ) -> Result<(), LoginError> {
        self.repo
            .record_login_failure(
                user_uuid,
                now,
                i16::from(MAX_LOGIN_FAILURES),
                now + Duration::minutes(LOCKOUT_MINUTES),
            )
            .await
            .map_err(|e| LoginError::Internal(e.to_string()))
    }
}

/// Паритет `ResolveIdentifier`: email trimmed+lower, иначе phone trimmed.
pub fn resolve_identifier(email: Option<&str>, phone: Option<&str>) -> String {
    let normalized_email = email.unwrap_or("").trim().to_lowercase();
    if !normalized_email.is_empty() {
        return normalized_email;
    }
    phone.unwrap_or("").trim().to_string()
}

/// Паритет `GetRequestContext` agent hash: Base64(SHA256(User-Agent)), ≤64.
pub fn agent_hash_from_user_agent(user_agent: &str) -> String {
    let digest = Sha256::digest(user_agent.as_bytes());
    let mut hash = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, digest);
    if hash.len() > 64 {
        hash.truncate(64);
    }
    hash
}

pub fn clamp_ip(ip: &str) -> String {
    let mut s = if ip.is_empty() {
        "unknown".into()
    } else {
        ip.to_string()
    };
    if s.len() > 45 {
        s.truncate(45);
    }
    s
}
