//! Client platforms — паритет `ClientPlatformService` (C#).

use sqlx::PgPool;
use uuid::Uuid;

pub struct ClientPlatformRepo {
    pool: PgPool,
}

impl ClientPlatformRepo {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Паритет `ClientPlatformService.ListUserUuidsAsync`.
    pub async fn list_user_uuids(&self, platform: &str) -> Result<Vec<Uuid>, String> {
        let plat = normalize_platform(platform);
        sqlx::query_scalar(
            r#"
            SELECT DISTINCT user_uuid
            FROM flora_core.user_client_platforms
            WHERE platform = $1
            "#,
        )
        .bind(plat)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }
}

fn normalize_platform(platform: &str) -> String {
    let p = platform.trim().to_ascii_lowercase();
    match p.as_str() {
        "ios" | "web" => p,
        _ => "android".into(),
    }
}
