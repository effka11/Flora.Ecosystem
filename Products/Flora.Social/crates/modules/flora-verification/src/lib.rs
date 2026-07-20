//! Модуль Verification. Фаза 2a: tonic-порт + in-process порт для Auth (Фаза 2b).

pub mod application;
pub mod infrastructure;
pub mod proto {
    tonic::include_proto!("flora.verification");
}

use std::net::SocketAddr;
use std::sync::Arc;

use flora_shared::config::FloraConfig;
use flora_verification_contracts::VerificationChallengePort;
use sqlx::PgPool;
use tokio::task::JoinHandle;

use crate::application::port_adapter::as_port;
use crate::application::service::ChallengeService;
use crate::application::smtp::{SmtpOptions, SmtpVerificationCodeSender};
use crate::infrastructure::repo::VerificationRepo;

pub type GrpcHandle = JoinHandle<()>;

pub struct VerificationBundle {
    pub port: Arc<dyn VerificationChallengePort>,
    pub grpc_handle: Option<GrpcHandle>,
}

pub fn router() -> axum::Router {
    axum::Router::new()
}

pub fn needs_pool(cfg: &FloraConfig) -> bool {
    cfg.get_bool("Verification:ServeNative") == Some(true)
        || cfg.get_bool("Auth:ServeNative") == Some(true)
}

/// In-process ChallengeService (+ optional gRPC при Verification:ServeNative).
pub fn compose(cfg: &FloraConfig, pool: PgPool) -> Option<VerificationBundle> {
    if !needs_pool(cfg) {
        return None;
    }

    let smtp = SmtpOptions::from_config(cfg);
    let development = cfg.is_development();
    let repo = Arc::new(VerificationRepo::new(pool));
    let sender = Arc::new(SmtpVerificationCodeSender::new(smtp, development));
    let service = Arc::new(ChallengeService::new(
        repo,
        sender,
        development,
        verification_code_pepper(cfg),
    ));
    let port = as_port(service.clone());

    let grpc_handle = if cfg.get_bool("Verification:ServeNative") == Some(true) {
        let listen = cfg
            .get_non_empty("Verification:GrpcListen")
            .unwrap_or("127.0.0.1:50051");
        match listen.parse::<SocketAddr>() {
            Ok(addr) if !development && !addr.ip().is_loopback() => {
                tracing::error!(
                    %addr,
                    "Verification gRPC без transport-аутентификации разрешён только на loopback"
                );
                None
            }
            Ok(addr) => Some(tokio::spawn(async move {
                if let Err(e) = serve(addr, (*service).clone()).await {
                    tracing::error!(error = %e, "Verification gRPC server stopped");
                }
            })),
            Err(e) => {
                tracing::error!(listen, error = %e, "Verification:GrpcListen невалиден");
                None
            }
        }
    } else {
        None
    };

    Some(VerificationBundle { port, grpc_handle })
}

fn verification_code_pepper(cfg: &FloraConfig) -> Vec<u8> {
    if let Some(pepper) = cfg
        .get_non_empty("Verification:CodePepper")
        .or_else(|| cfg.get_non_empty("Jwt:Secret"))
    {
        return pepper.as_bytes().to_vec();
    }

    // Host validation guarantees a configured secret in Production. Keep
    // direct/dev composition safe as well, at the cost of restart invalidation.
    let mut ephemeral = vec![0_u8; 48];
    getrandom::fill(&mut ephemeral).expect("OS CSPRNG");
    ephemeral
}

/// Обратная совместимость: только gRPC (старый API spawn_background).
pub fn spawn_grpc(cfg: &FloraConfig, pool: PgPool) -> Option<GrpcHandle> {
    compose(cfg, pool).and_then(|b| b.grpc_handle)
}

async fn serve(
    addr: SocketAddr,
    service: ChallengeService,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let grpc = application::grpc::VerificationGrpc::new(service);
    tracing::info!(%addr, "Verification gRPC listening");
    tonic::transport::Server::builder()
        .add_service(
            proto::verification_challenge_service_server::VerificationChallengeServiceServer::new(
                grpc,
            ),
        )
        .serve(addr)
        .await?;
    Ok(())
}
