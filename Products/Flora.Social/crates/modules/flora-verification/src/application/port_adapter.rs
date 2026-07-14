//! Адаптер `ChallengeService` → `VerificationChallengePort`.

use std::sync::Arc;

use flora_verification_contracts::{
    BoxFuture, ChallengeBeginResult, ChallengeValidateResult, ChallengeValidateStatus,
    VerificationChallengePort,
};
use uuid::Uuid;

use crate::application::service::{ChallengeError, ChallengeService, ValidateStatus};

pub struct ChallengePortAdapter {
    inner: Arc<ChallengeService>,
}

impl ChallengePortAdapter {
    pub fn new(inner: Arc<ChallengeService>) -> Self {
        Self { inner }
    }
}

impl VerificationChallengePort for ChallengePortAdapter {
    fn begin(
        &self,
        kind: i32,
        target: &str,
        subject_user_uuid: Option<Uuid>,
    ) -> BoxFuture<'_, Result<ChallengeBeginResult, String>> {
        let target = target.to_string();
        Box::pin(async move {
            let r = self
                .inner
                .begin(kind, &target, subject_user_uuid)
                .await
                .map_err(|e| match e {
                    ChallengeError::Smtp(_) => {
                        "Не удалось отправить код на email. Сервис почты временно недоступен — попробуйте позже."
                            .to_string()
                    }
                    ChallengeError::Db(db) => db.to_string(),
                })?;
            Ok(ChallengeBeginResult {
                token: r.token,
                expires_at_utc: r.expires_at_utc,
                dev_code: r.dev_code,
            })
        })
    }

    fn validate(
        &self,
        token: Uuid,
        code_plain: &str,
    ) -> BoxFuture<'_, Result<ChallengeValidateResult, String>> {
        let code = code_plain.to_string();
        Box::pin(async move {
            let r = self
                .inner
                .validate(token, &code)
                .await
                .map_err(|e| e.to_string())?;
            Ok(ChallengeValidateResult {
                status: match r.status {
                    ValidateStatus::Success => ChallengeValidateStatus::Success,
                    ValidateStatus::NotFound => ChallengeValidateStatus::NotFound,
                    ValidateStatus::Expired => ChallengeValidateStatus::Expired,
                    ValidateStatus::CodeMismatch => ChallengeValidateStatus::CodeMismatch,
                },
                target: r.target,
                subject_user_uuid: r.subject_user_uuid,
            })
        })
    }

    fn cancel(&self, token: Uuid) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.inner.cancel(token).await.map_err(|e| e.to_string())?;
            Ok(())
        })
    }
}

pub fn as_port(service: Arc<ChallengeService>) -> Arc<dyn VerificationChallengePort> {
    Arc::new(ChallengePortAdapter::new(service))
}
