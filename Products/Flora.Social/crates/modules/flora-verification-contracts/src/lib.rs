//! Контракты модуля Verification — DTO и trait-порты без бизнес-логики (next-architecture.md §2.2).

use std::future::Future;
use std::pin::Pin;

use chrono::{DateTime, Utc};
use uuid::Uuid;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// `VerificationChallengeKind.EmailRegistration`.
pub const KIND_EMAIL_REGISTRATION: i32 = 0;
/// `VerificationChallengeKind.EmailChange`.
pub const KIND_EMAIL_CHANGE: i32 = 1;
/// `VerificationChallengeKind.EmailPasswordReset`.
pub const KIND_EMAIL_PASSWORD_RESET: i32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum ChallengeValidateStatus {
    Success = 0,
    NotFound = 1,
    Expired = 2,
    CodeMismatch = 3,
}

#[derive(Debug, Clone)]
pub struct ChallengeBeginResult {
    pub token: Uuid,
    pub expires_at_utc: DateTime<Utc>,
    pub dev_code: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ChallengeValidateResult {
    pub status: ChallengeValidateStatus,
    pub target: Option<String>,
    pub subject_user_uuid: Option<Uuid>,
}

impl ChallengeValidateResult {
    pub fn success(&self) -> bool {
        self.status == ChallengeValidateStatus::Success
    }
}

/// Порт `IVerificationChallengeService` — Auth и др. вызывают только через contracts.
pub trait VerificationChallengePort: Send + Sync {
    fn begin(
        &self,
        kind: i32,
        target: &str,
        subject_user_uuid: Option<Uuid>,
    ) -> BoxFuture<'_, Result<ChallengeBeginResult, String>>;

    fn validate(
        &self,
        token: Uuid,
        code_plain: &str,
    ) -> BoxFuture<'_, Result<ChallengeValidateResult, String>>;

    fn cancel(&self, token: Uuid) -> BoxFuture<'_, Result<(), String>>;
}

/// Уровень подтверждённой человечности (FPP §2; права уровней — FGP §4.1.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PersonhoodLevel {
    V0,
    V1,
    V2,
    V3,
}

pub trait PersonhoodAttestor: Send + Sync {
    fn active_level(&self, account_uuid: Uuid) -> PersonhoodLevel;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_are_ordered() {
        assert!(PersonhoodLevel::V0 < PersonhoodLevel::V1);
        assert!(PersonhoodLevel::V1 < PersonhoodLevel::V2);
        assert!(PersonhoodLevel::V2 < PersonhoodLevel::V3);
    }
}
