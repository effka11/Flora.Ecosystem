//! Модуль Verification. Фаза 2a: tonic-порт challenge/SMTP (next-architecture.md §6).
//!
//! Публичного HTTP нет — только gRPC `VerificationChallengeService` при `Verification:ServeNative`.

pub mod application;
pub mod infrastructure;
pub mod proto {
    tonic::include_proto!("flora.verification");
}

use std::net::SocketAddr;
use std::sync::Arc;

use flora_shared::config::FloraConfig;
use sqlx::PgPool;
use tokio::task::JoinHandle;

use crate::application::service::ChallengeService;
use crate::application::smtp::{SmtpOptions, SmtpVerificationCodeSender};
use crate::infrastructure::repo::VerificationRepo;

/// Хэндл tonic-сервера (abort при shutdown хоста).
pub type GrpcHandle = JoinHandle<()>;

pub fn router() -> axum::Router {
    axum::Router::new()
}

pub fn needs_pool(cfg: &FloraConfig) -> bool {
    cfg.get_bool("Verification:ServeNative") == Some(true)
}

/// Поднимает tonic на `Verification:GrpcListen` (дефолт `127.0.0.1:50051`).
pub fn spawn_grpc(cfg: &FloraConfig, pool: PgPool) -> Option<GrpcHandle> {
    if !needs_pool(cfg) {
        return None;
    }

    let listen = cfg
        .get_non_empty("Verification:GrpcListen")
        .unwrap_or("127.0.0.1:50051");
    let addr: SocketAddr = match listen.parse() {
        Ok(a) => a,
        Err(e) => {
            tracing::error!(listen, error = %e, "Verification:GrpcListen невалиден");
            return None;
        }
    };

    let smtp = SmtpOptions::from_config(cfg);
    let development = cfg.is_development();
    let repo = Arc::new(VerificationRepo::new(pool));
    let sender = Arc::new(SmtpVerificationCodeSender::new(smtp, development));
    let service = ChallengeService::new(repo, sender, development);

    Some(tokio::spawn(async move {
        if let Err(e) = serve(addr, service).await {
            tracing::error!(error = %e, "Verification gRPC server stopped");
        }
    }))
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
