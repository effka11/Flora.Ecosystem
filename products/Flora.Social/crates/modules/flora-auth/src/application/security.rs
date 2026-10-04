//! Смена email/phone и 2FA — паритет `AuthAccountSecurityService.cs`.

use std::sync::Arc;

use flora_verification_contracts::{
    ChallengeValidateStatus, KIND_EMAIL_CHANGE, VerificationChallengePort,
};
use uuid::Uuid;

use crate::http::{EmailChangeBeginResponse, TwoFactorSetupResponse, format_utc};
use crate::infrastructure::password::verify_password;
use crate::infrastructure::repo::AuthRepo;
use crate::infrastructure::totp::{generate_totp_secret, otp_auth_uri, verify_totp};

#[derive(Debug)]
pub enum SecurityMutationError {
    BadRequest(&'static str),
    Conflict(&'static str),
    Internal(String),
}

pub struct SecurityService {
    repo: Arc<AuthRepo>,
    verification: Arc<dyn VerificationChallengePort>,
}

impl SecurityService {
    pub fn new(repo: Arc<AuthRepo>, verification: Arc<dyn VerificationChallengePort>) -> Self {
        Self { repo, verification }
    }

    pub async fn status(
        &self,
        user_uuid: Uuid,
    ) -> Result<crate::http::SecurityStatusResponse, sqlx::Error> {
        Ok(match self.repo.get_security_status(user_uuid).await? {
            Some(row) => crate::http::SecurityStatusResponse {
                two_factor_enabled: row.two_factor_enabled,
                email_verified: row.email_verified,
                phone_verified: row.phone_verified,
            },
            None => crate::http::SecurityStatusResponse {
                two_factor_enabled: false,
                email_verified: false,
                phone_verified: false,
            },
        })
    }

    pub async fn begin_email_change(
        &self,
        user_uuid: Uuid,
        password: &str,
        new_email: &str,
    ) -> Result<EmailChangeBeginResponse, SecurityMutationError> {
        let email = new_email.trim().to_lowercase();
        if email.is_empty() || !email.contains('@') {
            return Err(SecurityMutationError::BadRequest(
                "Укажите корректный email.",
            ));
        }
        if password.trim().is_empty() {
            return Err(SecurityMutationError::BadRequest("Укажите пароль."));
        }

        let Some(account) = self
            .repo
            .get_security_account(user_uuid)
            .await
            .map_err(|e| SecurityMutationError::Internal(e.to_string()))?
        else {
            return Err(SecurityMutationError::BadRequest("Аккаунт не найден."));
        };

        let password_owned = password.to_string();
        let hash = account.password_hash.clone();
        let ok = tokio::task::spawn_blocking(move || verify_password(&password_owned, &hash))
            .await
            .map_err(|e| SecurityMutationError::Internal(e.to_string()))?;
        if !ok {
            return Err(SecurityMutationError::BadRequest("Неверный пароль."));
        }

        let current = account.email.as_deref().unwrap_or("").trim().to_lowercase();
        if current == email {
            return Err(SecurityMutationError::BadRequest(
                "Новый email совпадает с текущим.",
            ));
        }

        if self
            .repo
            .email_taken_by_other(&email, user_uuid)
            .await
            .map_err(|e| SecurityMutationError::Internal(e.to_string()))?
        {
            return Err(SecurityMutationError::Conflict(
                "Этот email уже используется.",
            ));
        }

        let challenge = self
            .verification
            .begin(KIND_EMAIL_CHANGE, &email, Some(user_uuid))
            .await
            .map_err(|msg| {
                if msg.starts_with("Не удалось отправить код") {
                    SecurityMutationError::BadRequest(
                        "Не удалось отправить код на email. Сервис почты временно недоступен — попробуйте позже.",
                    )
                } else {
                    SecurityMutationError::Internal(msg)
                }
            })?;

        Ok(EmailChangeBeginResponse {
            change_token: challenge.token.to_string(),
            expires_at: format_utc(challenge.expires_at_utc),
            dev_verification_code: challenge.dev_code,
        })
    }

    pub async fn confirm_email_change(
        &self,
        user_uuid: Uuid,
        change_token_raw: &str,
        code: &str,
    ) -> Result<String, SecurityMutationError> {
        let Ok(change_token) = Uuid::parse_str(change_token_raw.trim()) else {
            return Err(SecurityMutationError::BadRequest(
                "Некорректный токен смены email.",
            ));
        };
        if code.trim().is_empty() {
            return Err(SecurityMutationError::BadRequest(
                "Укажите код подтверждения.",
            ));
        }

        let validation = self
            .verification
            .validate(change_token, code)
            .await
            .map_err(SecurityMutationError::Internal)?;

        if !validation.success() {
            return Err(
                if validation.status == ChallengeValidateStatus::CodeMismatch {
                    SecurityMutationError::BadRequest("Неверный код подтверждения.")
                } else {
                    SecurityMutationError::BadRequest(
                        "Запрос на смену email истёк. Начните заново.",
                    )
                },
            );
        }

        let Some(target) = validation.target.filter(|t| !t.trim().is_empty()) else {
            return Err(SecurityMutationError::BadRequest(
                "Запрос на смену email истёк. Начните заново.",
            ));
        };
        if validation.subject_user_uuid != Some(user_uuid) {
            return Err(SecurityMutationError::BadRequest(
                "Запрос на смену email истёк. Начните заново.",
            ));
        }

        if self
            .repo
            .get_security_account(user_uuid)
            .await
            .map_err(|e| SecurityMutationError::Internal(e.to_string()))?
            .is_none()
        {
            return Err(SecurityMutationError::BadRequest("Аккаунт не найден."));
        }

        if self
            .repo
            .email_taken_by_other(&target, user_uuid)
            .await
            .map_err(|e| SecurityMutationError::Internal(e.to_string()))?
        {
            return Err(SecurityMutationError::BadRequest(
                "Этот email уже используется.",
            ));
        }

        let now = chrono::Utc::now();
        self.repo
            .update_account_email(user_uuid, &target, now)
            .await
            .map_err(|e| SecurityMutationError::Internal(e.to_string()))?;

        let _ = self.verification.cancel(change_token).await;
        Ok(target)
    }

    pub async fn change_phone(
        &self,
        user_uuid: Uuid,
        password: &str,
        phone: &str,
    ) -> Result<(), SecurityMutationError> {
        let normalized = normalize_phone(phone);
        if normalized.is_empty() {
            return Err(SecurityMutationError::BadRequest("Укажите номер телефона."));
        }
        if password.trim().is_empty() {
            return Err(SecurityMutationError::BadRequest("Укажите пароль."));
        }

        let Some(account) = self
            .repo
            .get_security_account(user_uuid)
            .await
            .map_err(|e| SecurityMutationError::Internal(e.to_string()))?
        else {
            return Err(SecurityMutationError::BadRequest("Аккаунт не найден."));
        };

        let password_owned = password.to_string();
        let hash = account.password_hash.clone();
        let ok = tokio::task::spawn_blocking(move || verify_password(&password_owned, &hash))
            .await
            .map_err(|e| SecurityMutationError::Internal(e.to_string()))?;
        if !ok {
            return Err(SecurityMutationError::BadRequest("Неверный пароль."));
        }

        if account.phone == normalized && account.phone_verified {
            return Err(SecurityMutationError::BadRequest(
                "Новый номер совпадает с текущим.",
            ));
        }

        if self
            .repo
            .phone_taken_by_other(&normalized, user_uuid)
            .await
            .map_err(|e| SecurityMutationError::Internal(e.to_string()))?
        {
            return Err(SecurityMutationError::BadRequest(
                "Этот номер уже используется.",
            ));
        }

        let now = chrono::Utc::now();
        self.repo
            .update_account_phone(user_uuid, &normalized, now)
            .await
            .map_err(|e| SecurityMutationError::Internal(e.to_string()))?;
        Ok(())
    }

    pub async fn begin_two_factor_setup(
        &self,
        user_uuid: Uuid,
        password: &str,
    ) -> Result<TwoFactorSetupResponse, SecurityMutationError> {
        if password.trim().is_empty() {
            return Err(SecurityMutationError::BadRequest("Укажите пароль."));
        }

        let Some(account) = self
            .repo
            .get_security_account(user_uuid)
            .await
            .map_err(|e| SecurityMutationError::Internal(e.to_string()))?
        else {
            return Err(SecurityMutationError::BadRequest("Аккаунт не найден."));
        };

        let password_owned = password.to_string();
        let hash = account.password_hash.clone();
        let ok = tokio::task::spawn_blocking(move || verify_password(&password_owned, &hash))
            .await
            .map_err(|e| SecurityMutationError::Internal(e.to_string()))?;
        if !ok {
            return Err(SecurityMutationError::BadRequest("Неверный пароль."));
        }
        if account.two_factor_enabled {
            return Err(SecurityMutationError::BadRequest(
                "2FA уже включена. Сначала отключите её.",
            ));
        }

        let secret = generate_totp_secret();
        let now = chrono::Utc::now();
        self.repo
            .set_two_factor_secret(user_uuid, &secret, now)
            .await
            .map_err(|e| SecurityMutationError::Internal(e.to_string()))?;

        let account_label = account
            .email
            .filter(|s| !s.is_empty())
            .unwrap_or(account.username);
        Ok(TwoFactorSetupResponse {
            secret: secret.clone(),
            otp_auth_uri: otp_auth_uri(&secret, &account_label),
        })
    }

    pub async fn enable_two_factor(
        &self,
        user_uuid: Uuid,
        code: &str,
    ) -> Result<(), SecurityMutationError> {
        if code.trim().is_empty() {
            return Err(SecurityMutationError::BadRequest(
                "Укажите код из приложения.",
            ));
        }

        let Some(account) = self
            .repo
            .get_security_account(user_uuid)
            .await
            .map_err(|e| SecurityMutationError::Internal(e.to_string()))?
        else {
            return Err(SecurityMutationError::BadRequest("Аккаунт не найден."));
        };

        let Some(secret) = account.two_factor_secret.filter(|s| !s.trim().is_empty()) else {
            return Err(SecurityMutationError::BadRequest(
                "Сначала начните настройку 2FA.",
            ));
        };
        if account.two_factor_enabled {
            return Err(SecurityMutationError::BadRequest("2FA уже включена."));
        }

        let code_owned = code.to_string();
        let secret_owned = secret;
        let ok = tokio::task::spawn_blocking(move || verify_totp(Some(&secret_owned), &code_owned))
            .await
            .map_err(|e| SecurityMutationError::Internal(e.to_string()))?;
        if !ok {
            return Err(SecurityMutationError::BadRequest(
                "Неверный код из приложения.",
            ));
        }

        let now = chrono::Utc::now();
        self.repo
            .enable_two_factor(user_uuid, now)
            .await
            .map_err(|e| SecurityMutationError::Internal(e.to_string()))?;
        Ok(())
    }

    pub async fn disable_two_factor(
        &self,
        user_uuid: Uuid,
        password: &str,
        code: &str,
    ) -> Result<(), SecurityMutationError> {
        if password.trim().is_empty() {
            return Err(SecurityMutationError::BadRequest("Укажите пароль."));
        }
        if code.trim().is_empty() {
            return Err(SecurityMutationError::BadRequest(
                "Укажите код из приложения.",
            ));
        }

        let Some(account) = self
            .repo
            .get_security_account(user_uuid)
            .await
            .map_err(|e| SecurityMutationError::Internal(e.to_string()))?
        else {
            return Err(SecurityMutationError::BadRequest("Аккаунт не найден."));
        };

        let Some(secret) = account.two_factor_secret.filter(|s| !s.trim().is_empty()) else {
            return Err(SecurityMutationError::BadRequest("2FA не включена."));
        };
        if !account.two_factor_enabled {
            return Err(SecurityMutationError::BadRequest("2FA не включена."));
        }

        let password_owned = password.to_string();
        let hash = account.password_hash.clone();
        let ok = tokio::task::spawn_blocking(move || verify_password(&password_owned, &hash))
            .await
            .map_err(|e| SecurityMutationError::Internal(e.to_string()))?;
        if !ok {
            return Err(SecurityMutationError::BadRequest("Неверный пароль."));
        }

        let code_owned = code.to_string();
        let secret_owned = secret;
        let ok = tokio::task::spawn_blocking(move || verify_totp(Some(&secret_owned), &code_owned))
            .await
            .map_err(|e| SecurityMutationError::Internal(e.to_string()))?;
        if !ok {
            return Err(SecurityMutationError::BadRequest(
                "Неверный код из приложения.",
            ));
        }

        let now = chrono::Utc::now();
        self.repo
            .disable_two_factor(user_uuid, now)
            .await
            .map_err(|e| SecurityMutationError::Internal(e.to_string()))?;
        Ok(())
    }
}

/// Паритет `NormalizePhone` в AuthAccountSecurityService.
pub fn normalize_phone(raw: &str) -> String {
    if raw.trim().is_empty() {
        return String::new();
    }
    let mut digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return String::new();
    }
    if digits.starts_with('8') && digits.len() == 11 {
        digits = format!("7{}", &digits[1..]);
    }
    if digits.len() == 10 {
        digits = format!("7{digits}");
    }
    if digits.len() > 20 {
        digits.truncate(20);
    }
    digits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_phone_ru_mobile() {
        assert_eq!(normalize_phone("+7 (900) 123-45-67"), "79001234567");
        assert_eq!(normalize_phone("89001234567"), "79001234567");
        assert_eq!(normalize_phone("9001234567"), "79001234567");
    }
}
