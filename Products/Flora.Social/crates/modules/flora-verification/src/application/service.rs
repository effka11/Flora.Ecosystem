//! Паритет с VerificationChallengeService (C#).

use std::sync::Arc;

use chrono::{Duration, Utc};
use flora_shared::flora_uuid::new_uuid;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::application::smtp::{SendError, SmtpVerificationCodeSender};
use crate::infrastructure::repo::{ChallengeRow, VerificationRepo};

const EXPIRATION_MINUTES: i64 = 15;
const MAX_ATTEMPTS: i32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum ValidateStatus {
    Success = 0,
    NotFound = 1,
    Expired = 2,
    CodeMismatch = 3,
}

#[derive(Debug, Clone)]
pub struct BeginResult {
    pub token: Uuid,
    pub expires_at_utc: chrono::DateTime<Utc>,
    pub dev_code: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ValidateResult {
    pub status: ValidateStatus,
    pub target: Option<String>,
    pub subject_user_uuid: Option<Uuid>,
}

#[derive(Debug)]
pub enum ChallengeError {
    Smtp(SendError),
    Db(sqlx::Error),
}

impl std::fmt::Display for ChallengeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Smtp(e) => write!(f, "{e}"),
            Self::Db(e) => write!(f, "{e}"),
        }
    }
}

#[derive(Clone)]
pub struct ChallengeService {
    repo: Arc<VerificationRepo>,
    sender: Arc<SmtpVerificationCodeSender>,
    development: bool,
}

impl ChallengeService {
    pub fn new(
        repo: Arc<VerificationRepo>,
        sender: Arc<SmtpVerificationCodeSender>,
        development: bool,
    ) -> Self {
        Self {
            repo,
            sender,
            development,
        }
    }

    pub async fn begin(
        &self,
        kind: i32,
        target: &str,
        subject_user_uuid: Option<Uuid>,
    ) -> Result<BeginResult, ChallengeError> {
        let normalized = target.trim().to_lowercase();
        let now = Utc::now();

        self.repo
            .remove_expired(now)
            .await
            .map_err(ChallengeError::Db)?;

        let code = generate_code();
        let token = new_uuid();
        let expires_at = now + Duration::minutes(EXPIRATION_MINUTES);
        let row = ChallengeRow {
            token,
            kind,
            target: normalized.clone(),
            subject_user_uuid,
            code_hash: hash_code(&code),
            expires_at,
            created_at: now,
            updated_at: now,
            attempts: 0,
        };

        self.repo.add(&row).await.map_err(ChallengeError::Db)?;

        self.sender
            .send_email_verification_code(&normalized, &code)
            .await
            .map_err(ChallengeError::Smtp)?;

        Ok(BeginResult {
            token,
            expires_at_utc: expires_at,
            dev_code: if self.development { Some(code) } else { None },
        })
    }

    pub async fn validate(
        &self,
        token: Uuid,
        code_plain: &str,
    ) -> Result<ValidateResult, ChallengeError> {
        if code_plain.trim().is_empty() {
            return Ok(ValidateResult {
                status: ValidateStatus::CodeMismatch,
                target: None,
                subject_user_uuid: None,
            });
        }

        let challenge = self
            .repo
            .find_by_token(token)
            .await
            .map_err(ChallengeError::Db)?;
        let Some(challenge) = challenge else {
            return Ok(ValidateResult {
                status: ValidateStatus::NotFound,
                target: None,
                subject_user_uuid: None,
            });
        };

        if challenge.expires_at <= Utc::now() {
            self.repo
                .remove(challenge.token)
                .await
                .map_err(ChallengeError::Db)?;
            return Ok(ValidateResult {
                status: ValidateStatus::Expired,
                target: None,
                subject_user_uuid: None,
            });
        }

        if !fixed_time_hash_equals(&challenge.code_hash, &hash_code(code_plain.trim())) {
            let attempts = challenge.attempts + 1;
            if attempts >= MAX_ATTEMPTS {
                self.repo
                    .remove(challenge.token)
                    .await
                    .map_err(ChallengeError::Db)?;
            } else {
                self.repo
                    .update_attempts(challenge.token, attempts, Utc::now())
                    .await
                    .map_err(ChallengeError::Db)?;
            }
            return Ok(ValidateResult {
                status: ValidateStatus::CodeMismatch,
                target: None,
                subject_user_uuid: None,
            });
        }

        Ok(ValidateResult {
            status: ValidateStatus::Success,
            target: Some(challenge.target),
            subject_user_uuid: challenge.subject_user_uuid,
        })
    }

    pub async fn cancel(&self, token: Uuid) -> Result<(), ChallengeError> {
        let challenge = self
            .repo
            .find_by_token(token)
            .await
            .map_err(ChallengeError::Db)?;
        if challenge.is_none() {
            return Ok(());
        }
        self.repo.remove(token).await.map_err(ChallengeError::Db)?;
        Ok(())
    }
}

fn generate_code() -> String {
    use getrandom::fill;
    let mut buf = [0u8; 4];
    fill(&mut buf).expect("CSPRNG");
    let n = u32::from_le_bytes(buf) % 1_000_000;
    format!("{n:06}")
}

/// `Convert.ToHexString(SHA256(...))` — uppercase hex.
pub fn hash_code(code: &str) -> String {
    let digest = Sha256::digest(code.as_bytes());
    hex::encode_upper(digest)
}

fn fixed_time_hash_equals(expected: &str, actual: &str) -> bool {
    if expected.len() != actual.len() {
        return false;
    }
    expected.as_bytes().ct_eq(actual.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_matches_known_sha256_uppercase() {
        // echo -n 123456 | sha256sum
        assert_eq!(
            hash_code("123456"),
            "8D969EEF6ECAD3C29A3A629280E686CF0C3F5D5A86AFF3CA12020C923ADC6C92"
        );
    }

    #[test]
    fn fixed_time_rejects_different_lengths() {
        assert!(!fixed_time_hash_equals("AA", "AABB"));
        assert!(fixed_time_hash_equals("AABB", "AABB"));
    }
}
