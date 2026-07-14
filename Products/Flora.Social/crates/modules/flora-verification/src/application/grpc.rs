//! tonic-обёртка над ChallengeService.

use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::application::service::{ChallengeError, ChallengeService};
use crate::application::smtp::SendError;
use crate::proto::verification_challenge_service_server::VerificationChallengeService;
use crate::proto::{
    BeginRequest, BeginResponse, CancelRequest, CancelResponse, ValidateRequest, ValidateResponse,
};

pub struct VerificationGrpc {
    inner: ChallengeService,
}

impl VerificationGrpc {
    pub fn new(inner: ChallengeService) -> Self {
        Self { inner }
    }
}

#[tonic::async_trait]
impl VerificationChallengeService for VerificationGrpc {
    async fn begin(
        &self,
        request: Request<BeginRequest>,
    ) -> Result<Response<BeginResponse>, Status> {
        let req = request.into_inner();
        let subject = parse_optional_uuid(&req.subject_user_uuid)?;
        match self
            .inner
            .begin(req.kind, &req.target, subject)
            .await
        {
            Ok(r) => Ok(Response::new(BeginResponse {
                token: r.token.to_string(),
                expires_at_utc: r.expires_at_utc.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                dev_code: r.dev_code.unwrap_or_default(),
            })),
            Err(e) => Err(map_error(e)),
        }
    }

    async fn validate(
        &self,
        request: Request<ValidateRequest>,
    ) -> Result<Response<ValidateResponse>, Status> {
        let req = request.into_inner();
        let token = parse_uuid(&req.token)?;
        match self.inner.validate(token, &req.code_plain).await {
            Ok(r) => Ok(Response::new(ValidateResponse {
                status: r.status as i32,
                target: r.target.unwrap_or_default(),
                subject_user_uuid: r
                    .subject_user_uuid
                    .map(|u| u.to_string())
                    .unwrap_or_default(),
            })),
            Err(e) => Err(map_error(e)),
        }
    }

    async fn cancel(
        &self,
        request: Request<CancelRequest>,
    ) -> Result<Response<CancelResponse>, Status> {
        let req = request.into_inner();
        let token = parse_uuid(&req.token)?;
        match self.inner.cancel(token).await {
            Ok(()) => Ok(Response::new(CancelResponse {})),
            Err(e) => Err(map_error(e)),
        }
    }
}

#[allow(clippy::result_large_err)]
fn parse_uuid(s: &str) -> Result<Uuid, Status> {
    Uuid::parse_str(s.trim()).map_err(|_| Status::invalid_argument("token UUID invalid"))
}

#[allow(clippy::result_large_err)]
fn parse_optional_uuid(s: &str) -> Result<Option<Uuid>, Status> {
    let t = s.trim();
    if t.is_empty() {
        return Ok(None);
    }
    Ok(Some(parse_uuid(t)?))
}

fn map_error(e: ChallengeError) -> Status {
    match e {
        ChallengeError::Smtp(SendError::NotConfiguredProduction) => {
            Status::failed_precondition(e.to_string())
        }
        ChallengeError::Smtp(SendError::Smtp(_)) => Status::unavailable(e.to_string()),
        ChallengeError::Db(_) => Status::internal(e.to_string()),
    }
}
