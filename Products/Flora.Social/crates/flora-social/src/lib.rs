//! Продукт Flora.Social — единственное место композиции модулей
//! (порт `Products/Flora.Social/FloraSocialComposition.cs`). Без бизнес-логики.
//!
//! Вместо DI-контейнера — явная композиция (next-architecture.md §2.4).

mod jwt_layer;

use flora_auth::infrastructure::jwt::JwtOptions;
use flora_shared::config::FloraConfig;
use flora_shared::npgsql::NpgsqlConnectionString;
use sqlx::PgPool;

/// Объединённый роутер продукта. `pool` — общий PgPool для нативных модулей
/// (`Music` / `Auth` ServeNative); `None` если натив не нужен.
pub fn product_router(cfg: &FloraConfig, pool: Option<PgPool>) -> axum::Router {
    axum::Router::new()
        .merge(flora_users::router())
        .merge(flora_verification::router())
        .merge(auth_router(cfg, pool.clone()))
        .merge(flora_notifications::router())
        .merge(flora_content::router())
        .merge(flora_messaging::router())
        .merge(music_router(cfg, pool))
        .merge(economy_router(cfg))
}

fn auth_router(cfg: &FloraConfig, pool: Option<PgPool>) -> axum::Router {
    if cfg.get_bool("Auth:ServeNative") != Some(true) {
        return flora_auth::router();
    }
    let Some(pool) = pool else {
        eprintln!("flora-auth: Auth:ServeNative=true, но PgPool недоступен — модуль офлайн");
        return flora_auth::router();
    };
    let module = flora_auth::compose(pool);
    with_jwt(cfg, module.router)
}

fn music_router(cfg: &FloraConfig, pool: Option<PgPool>) -> axum::Router {
    if cfg.get_bool("Music:ServeNative") != Some(true) {
        return flora_music::router();
    }
    let Some(pool) = pool else {
        eprintln!("flora-music: Music:ServeNative=true, но PgPool недоступен — модуль офлайн");
        return flora_music::router();
    };
    let media = flora_music::MusicMediaOptions {
        ffmpeg_path: cfg
            .get_non_empty("Media:FfmpegPath")
            .unwrap_or("ffmpeg")
            .to_string(),
        ffprobe_path: cfg.get("Media:FfprobePath").unwrap_or("").to_string(),
    };
    let module = flora_music::compose(pool, media);
    with_jwt(cfg, module.router)
}

fn with_jwt(cfg: &FloraConfig, router: axum::Router) -> axum::Router {
    let jwt = JwtAuthLayerState::from_config(cfg);
    router.layer(axum::middleware::from_fn_with_state(
        jwt_layer::JwtAuthState {
            options: jwt.options,
        },
        jwt_layer::require_bearer_jwt,
    ))
}

struct JwtAuthLayerState {
    options: JwtOptions,
}

impl JwtAuthLayerState {
    fn from_config(cfg: &FloraConfig) -> Self {
        Self {
            options: JwtOptions::from_config(cfg),
        }
    }
}

fn economy_router(cfg: &FloraConfig) -> axum::Router {
    if cfg.get_bool("Economy:Enabled") != Some(true) {
        return flora_economy::router();
    }
    let path = cfg
        .get_non_empty("Economy:LedgerPath")
        .unwrap_or("flora-economy.ledger.jsonl");
    let store = std::sync::Arc::new(flora_economy::infrastructure::JsonlLedgerStore::new(
        std::path::PathBuf::from(path),
    ));
    let attestor = std::sync::Arc::new(flora_economy::infrastructure::ConservativeAttestor);
    match flora_economy::compose(store, attestor) {
        Ok(module) => module.router,
        Err(e) => {
            eprintln!("flora-economy: композиция отклонена, модуль офлайн: {e}");
            flora_economy::router()
        }
    }
}

/// Подключение PgPool из `ConnectionStrings:FloraDatabase` (формат Npgsql).
pub async fn connect_pool(cfg: &FloraConfig) -> Result<PgPool, String> {
    let raw = cfg
        .get_non_empty("ConnectionStrings:FloraDatabase")
        .ok_or_else(|| "ConnectionStrings:FloraDatabase не задана".to_string())?;
    let parsed = NpgsqlConnectionString::parse(raw).map_err(|e| e.to_string())?;
    let mut options = sqlx::postgres::PgConnectOptions::new()
        .host(parsed.host.as_deref().unwrap_or("localhost"))
        .port(parsed.port.unwrap_or(5432));
    if let Some(database) = &parsed.database {
        options = options.database(database);
    }
    if let Some(username) = &parsed.username {
        options = options.username(username);
    }
    if let Some(password) = &parsed.password {
        options = options.password(password);
    }
    if let Some(ssl_mode) = &parsed.ssl_mode {
        options = options.ssl_mode(match ssl_mode.to_lowercase().as_str() {
            "disable" => sqlx::postgres::PgSslMode::Disable,
            "require" => sqlx::postgres::PgSslMode::Require,
            "allow" => sqlx::postgres::PgSslMode::Allow,
            _ => sqlx::postgres::PgSslMode::Prefer,
        });
    }
    if let Some(search_path) = &parsed.search_path {
        options = options.options([("search_path", search_path.as_str())]);
    }
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .map_err(|e| e.to_string())
}

pub fn music_needs_pool(cfg: &FloraConfig) -> bool {
    cfg.get_bool("Music:ServeNative") == Some(true)
}

pub fn auth_needs_pool(cfg: &FloraConfig) -> bool {
    cfg.get_bool("Auth:ServeNative") == Some(true)
}

pub fn verification_needs_pool(cfg: &FloraConfig) -> bool {
    flora_verification::needs_pool(cfg)
}

/// Нужен ли PgPool хосту (Music/Auth ServeNative и/или Verification gRPC).
pub fn host_needs_pool(cfg: &FloraConfig) -> bool {
    music_needs_pool(cfg) || auth_needs_pool(cfg) || verification_needs_pool(cfg)
}

/// Фоновые задачи продукта (Music workers, Verification gRPC, …).
pub type BackgroundHandle = flora_music::WorkerHandle;

/// Хэндл фонового Music-воркера (abort при shutdown).
pub type MusicWorkerHandle = BackgroundHandle;

/// Запускает Music workers только при `Music:ServeNative` + живом пуле.
pub fn spawn_music_workers(cfg: &FloraConfig, pool: PgPool) -> Vec<MusicWorkerHandle> {
    if !music_needs_pool(cfg) {
        return Vec::new();
    }
    flora_music::spawn_workers(pool)
}

/// Verification tonic + Music workers.
pub fn spawn_background(cfg: &FloraConfig, pool: PgPool) -> Vec<BackgroundHandle> {
    let mut handles = spawn_music_workers(cfg, pool.clone());
    if let Some(h) = flora_verification::spawn_grpc(cfg, pool) {
        handles.push(h);
    }
    handles
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::util::ServiceExt;

    #[tokio::test]
    async fn empty_product_router_matches_nothing() {
        let router = product_router(&FloraConfig::default(), None);
        let response = router
            .oneshot(
                http::Request::builder()
                    .uri("/api/music/tracks/library")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn economy_disabled_by_default() {
        let router = product_router(&FloraConfig::default(), None);
        let response = router
            .oneshot(
                http::Request::builder()
                    .uri("/api/economy/ledger/head")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn economy_enabled_serves_ledger_head() {
        let path =
            std::env::temp_dir().join(format!("flora-social-economy-{}.jsonl", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let cfg = FloraConfig::from_layers(
            "Development",
            &[serde_json::json!({
                "Economy": { "Enabled": true, "LedgerPath": path.to_string_lossy() }
            })],
            &[],
        );
        let router = product_router(&cfg, None);
        let response = router
            .oneshot(
                http::Request::builder()
                    .uri("/api/economy/ledger/head")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), http::StatusCode::OK);
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn music_serve_native_without_pool_stays_empty() {
        let cfg = FloraConfig::from_layers(
            "Development",
            &[serde_json::json!({ "Music": { "ServeNative": true } })],
            &[],
        );
        let router = product_router(&cfg, None);
        let response = router
            .oneshot(
                http::Request::builder()
                    .uri("/api/music/genres")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn auth_serve_native_without_pool_stays_empty() {
        let cfg = FloraConfig::from_layers(
            "Development",
            &[serde_json::json!({ "Auth": { "ServeNative": true } })],
            &[],
        );
        let router = product_router(&cfg, None);
        let response = router
            .oneshot(
                http::Request::builder()
                    .uri("/api/auth/me/sessions")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), http::StatusCode::NOT_FOUND);
    }
}
