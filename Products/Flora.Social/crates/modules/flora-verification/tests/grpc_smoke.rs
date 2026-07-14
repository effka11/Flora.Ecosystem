//! Локальный smoke gRPC Verification (нужны Postgres + flora-api с ServeNative).
//!
//!   $env:FLORA_VERIFICATION_SMOKE=1
//!   cargo test -p flora-verification --test grpc_smoke -- --nocapture

use flora_verification::proto::verification_challenge_service_client::VerificationChallengeServiceClient;
use flora_verification::proto::{BeginRequest, CancelRequest, ValidateRequest};

#[tokio::test]
async fn begin_validate_cancel_against_local_grpc() {
    if std::env::var("FLORA_VERIFICATION_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_VERIFICATION_SMOKE=1");
        return;
    }

    let mut client = VerificationChallengeServiceClient::connect("http://127.0.0.1:50051")
        .await
        .expect("connect :50051 — is flora-api running with Verification:ServeNative?");

    let begin = client
        .begin(BeginRequest {
            kind: 0,
            target: "smoke-verification@flora.local".into(),
            subject_user_uuid: String::new(),
        })
        .await
        .expect("Begin")
        .into_inner();

    assert!(!begin.token.is_empty(), "token");
    assert!(!begin.expires_at_utc.is_empty(), "expires");
    // Development: DevCode must be present when SMTP not configured.
    assert!(
        begin.dev_code.len() == 6,
        "dev_code expected in Development, got {:?}",
        begin.dev_code
    );

    let bad = client
        .validate(ValidateRequest {
            token: begin.token.clone(),
            code_plain: "000000".into(),
        })
        .await
        .expect("Validate mismatch")
        .into_inner();
    assert_eq!(bad.status, 3, "CodeMismatch");

    let ok = client
        .validate(ValidateRequest {
            token: begin.token.clone(),
            code_plain: begin.dev_code.clone(),
        })
        .await
        .expect("Validate ok")
        .into_inner();
    assert_eq!(ok.status, 0, "Success");
    assert_eq!(ok.target, "smoke-verification@flora.local");

    client
        .cancel(CancelRequest {
            token: begin.token.clone(),
        })
        .await
        .expect("Cancel");

    let gone = client
        .validate(ValidateRequest {
            token: begin.token,
            code_plain: begin.dev_code,
        })
        .await
        .expect("Validate after cancel")
        .into_inner();
    assert_eq!(gone.status, 1, "NotFound after cancel");
}
