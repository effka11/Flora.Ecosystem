use std::sync::Arc;

use chrono::{Duration, Utc};
use flora_shared::flora_uuid::new_uuid;
use flora_shared::latin_identifiers::normalize_username;
use flora_users_contracts::{UserProfileProvisioner, UserProfileReadQueries};
use flora_verification_contracts::{
    ChallengeValidateStatus, KIND_EMAIL_REGISTRATION, VerificationChallengePort,
};
use uuid::Uuid;

use crate::application::login::SessionHints;
use crate::domain::reserved_usernames;
use crate::http::{LoginResponse, RegisterInitResponse, format_utc};
use crate::infrastructure::jwt::{AccessTokenClaims, JwtOptions, issue_access_token};
use crate::infrastructure::password::{MAX_PASSWORD_BYTES, hash_password};
use crate::infrastructure::repo::AuthRepo;
use crate::infrastructure::tokens::{
    generate_csrf_token, generate_hmac_key, generate_jwt_id, generate_refresh_token,
};

#[derive(Debug)]
pub enum RegisterBeginError {
    BadRequest(&'static str),
    Conflict(&'static str),
    Internal(String),
}

#[derive(Debug)]
pub enum RegisterVerifyError {
    BadRequest(&'static str),
    Unauthorized(String),
    Conflict(&'static str),
    Internal(String),
}

pub struct RegisterService {
    repo: Arc<AuthRepo>,
    jwt: JwtOptions,
    verification: Arc<dyn VerificationChallengePort>,
    profiles: Arc<dyn UserProfileReadQueries>,
    provisioner: Arc<dyn UserProfileProvisioner>,
}

impl RegisterService {
    pub fn new(
        repo: Arc<AuthRepo>,
        jwt: JwtOptions,
        verification: Arc<dyn VerificationChallengePort>,
        profiles: Arc<dyn UserProfileReadQueries>,
        provisioner: Arc<dyn UserProfileProvisioner>,
    ) -> Self {
        Self {
            repo,
            jwt,
            verification,
            profiles,
            provisioner,
        }
    }

    pub async fn begin(
        &self,
        email_or_empty: &str,
        password: &str,
    ) -> Result<RegisterInitResponse, RegisterBeginError> {
        if password.trim().is_empty() {
            return Err(RegisterBeginError::BadRequest("Пароль обязателен."));
        }
        if password.chars().count() < 8 {
            return Err(RegisterBeginError::BadRequest(
                "Пароль должен быть не короче 8 символов.",
            ));
        }
        if password.len() > MAX_PASSWORD_BYTES {
            return Err(RegisterBeginError::BadRequest("Пароль слишком длинный."));
        }
        let email = email_or_empty.trim().to_lowercase();
        if email.is_empty() || !email.contains('@') {
            return Err(RegisterBeginError::BadRequest("Укажите корректный email."));
        }

        let now = Utc::now();
        let _ = self
            .repo
            .cleanup_expired_pending(now)
            .await
            .map_err(|e| RegisterBeginError::Internal(e.to_string()))?;

        if self
            .repo
            .email_exists(&email)
            .await
            .map_err(|e| RegisterBeginError::Internal(e.to_string()))?
        {
            return Err(RegisterBeginError::Conflict(
                "Аккаунт с этим email уже существует.",
            ));
        }

        let password_owned = password.to_string();
        let password_hash = tokio::task::spawn_blocking(move || hash_password(&password_owned))
            .await
            .map_err(|e| RegisterBeginError::Internal(e.to_string()))?;
        let username = build_username_from_email(&email);

        let challenge = self
            .verification
            .begin(KIND_EMAIL_REGISTRATION, &email, None)
            .await
            .map_err(|msg| {
                if msg.starts_with("Не удалось отправить код") {
                    RegisterBeginError::BadRequest(
                        "Не удалось отправить код на email. Сервис почты временно недоступен — попробуйте позже.",
                    )
                } else {
                    RegisterBeginError::Internal(msg)
                }
            })?;

        let superseded = self
            .repo
            .delete_pending_by_email(&email)
            .await
            .map_err(|e| RegisterBeginError::Internal(e.to_string()))?;

        self.repo
            .insert_pending(
                challenge.token,
                &email,
                &username,
                &password_hash,
                challenge.expires_at_utc,
                now,
            )
            .await
            .map_err(|e| RegisterBeginError::Internal(e.to_string()))?;

        for token in superseded.into_iter().filter(|t| *t != challenge.token) {
            let _ = self.verification.cancel(token).await;
        }

        Ok(RegisterInitResponse {
            verification_token: challenge.token.to_string(),
            expires_at: format_utc(challenge.expires_at_utc),
            dev_verification_code: challenge.dev_code,
        })
    }

    pub async fn verify(
        &self,
        verification_token: Uuid,
        code_plain: &str,
        hints: SessionHints,
    ) -> Result<LoginResponse, RegisterVerifyError> {
        if code_plain.trim().is_empty() {
            return Err(RegisterVerifyError::BadRequest("Введите код из сообщения."));
        }

        let now = Utc::now();
        let _ = self
            .repo
            .cleanup_expired_pending(now)
            .await
            .map_err(|e| RegisterVerifyError::Internal(e.to_string()))?;

        let pending = self
            .repo
            .get_pending(verification_token)
            .await
            .map_err(|e| RegisterVerifyError::Internal(e.to_string()))?;

        let Some(pending) = pending else {
            return Err(RegisterVerifyError::Unauthorized(
                "Токен верификации истек или недействителен.".into(),
            ));
        };

        if pending.expires_at <= now {
            return self
                .expire_pending(pending.verification_token, "Код верификации истек.")
                .await;
        }

        let validation = self
            .verification
            .validate(verification_token, code_plain)
            .await
            .map_err(RegisterVerifyError::Internal)?;

        if !validation.success() {
            return match validation.status {
                ChallengeValidateStatus::Expired => {
                    self.expire_pending(verification_token, "Код верификации истек.")
                        .await
                }
                ChallengeValidateStatus::NotFound => {
                    self.expire_pending(
                        verification_token,
                        "Токен верификации истек или недействителен.",
                    )
                    .await
                }
                _ => Err(RegisterVerifyError::Unauthorized(
                    "Неверный код из сообщения.".into(),
                )),
            };
        }

        if self
            .repo
            .email_exists(&pending.email)
            .await
            .map_err(|e| RegisterVerifyError::Internal(e.to_string()))?
        {
            let _ = self.repo.delete_pending(verification_token).await;
            let _ = self.verification.cancel(verification_token).await;
            return Err(RegisterVerifyError::Conflict(
                "Аккаунт с этим email уже существует.",
            ));
        }

        let user_uuid = new_uuid();
        let phone = {
            let n = user_uuid.as_simple().to_string();
            format!("e-{}", &n[..18])
        };
        self.repo
            .insert_registered_account(
                user_uuid,
                &pending.email,
                &pending.username,
                &phone,
                &pending.password_hash,
                now,
            )
            .await
            .map_err(|e| RegisterVerifyError::Internal(e.to_string()))?;

        let jwt_id = generate_jwt_id();
        let session_id = new_uuid();
        let refresh_token = generate_refresh_token(session_id, self.jwt.secret.as_bytes());
        let access_expires = now + Duration::minutes(self.jwt.access_token_minutes);
        let refresh_expires = now + Duration::days(self.jwt.refresh_token_days);

        self.repo
            .insert_session(
                session_id,
                user_uuid,
                &hints.agent_hash,
                &hints.ip,
                refresh_expires,
                now,
                &jwt_id,
                &refresh_token,
                &generate_csrf_token(),
                &generate_hmac_key(),
            )
            .await
            .map_err(|e| RegisterVerifyError::Internal(e.to_string()))?;

        self.repo
            .delete_pending(verification_token)
            .await
            .map_err(|e| RegisterVerifyError::Internal(e.to_string()))?;

        self.provisioner
            .ensure_initial_profile(user_uuid, "")
            .await
            .map_err(RegisterVerifyError::Internal)?;

        let _ = self.verification.cancel(verification_token).await;

        let access_token = issue_access_token(
            &self.jwt,
            &AccessTokenClaims {
                sub: user_uuid.to_string(),
                email: pending.email,
                jti: jwt_id,
                expires_at: access_expires.timestamp(),
            },
        );

        let requires_profile = self
            .profiles
            .requires_profile_completion(user_uuid)
            .await
            .map_err(RegisterVerifyError::Internal)?;

        Ok(LoginResponse {
            access_token,
            refresh_token,
            expires_at: format_utc(access_expires),
            token_type: "Bearer".into(),
            requires_profile_completion: requires_profile,
        })
    }

    pub async fn cancel(&self, verification_token: Uuid) -> Result<(), String> {
        let _ = self.repo.delete_pending(verification_token).await;
        let _ = self.verification.cancel(verification_token).await;
        Ok(())
    }

    async fn expire_pending(
        &self,
        token: Uuid,
        message: &'static str,
    ) -> Result<LoginResponse, RegisterVerifyError> {
        let _ = self.repo.delete_pending(token).await;
        let _ = self.verification.cancel(token).await;
        Err(RegisterVerifyError::Unauthorized(message.into()))
    }
}

fn build_username_from_email(email: &str) -> String {
    let base = email.split('@').next().unwrap_or("").trim();
    let base = if base.is_empty() { "user" } else { base };
    let normalized = normalize_username(Some(base), 50);
    if normalized.is_empty()
        || normalized.len() < 2
        || normalized.chars().all(|c| c == '_')
        || reserved_usernames::is_reserved(&normalized)
    {
        let n = new_uuid().as_simple().to_string();
        return format!("user_{}", &n[..8]);
    }
    normalized
}
