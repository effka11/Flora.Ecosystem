//! Продукт Flora.Social — единственное место композиции модулей
//! (порт `Products/Flora.Social/FloraSocialComposition.cs`). Без бизнес-логики.
//!
//! Вместо DI-контейнера — явная композиция (next-architecture.md §2.4).

mod jwt_layer;

use std::sync::Arc;

use flora_auth::infrastructure::jwt::JwtOptions;
use flora_shared::config::FloraConfig;
use flora_shared::npgsql::NpgsqlConnectionString;
use flora_verification_contracts::VerificationChallengePort;
use sqlx::PgPool;

/// Результат композиции продукта: HTTP + фоновые хэндлы (Music workers, Verification gRPC).
pub struct ProductComposition {
    pub router: axum::Router,
    pub background: Vec<BackgroundHandle>,
}

/// Объединённый роутер продукта. `pool` — общий PgPool для нативных модулей
/// (`Music` / `Auth` ServeNative); `None` если натив не нужен.
///
/// Для хоста предпочтителен [`compose_product`] — один VerificationBundle на Auth + gRPC.
pub fn product_router(cfg: &FloraConfig, pool: Option<PgPool>) -> axum::Router {
    compose_product(cfg, pool).router
}

/// Композиция роутера и фоновых задач без двойного ChallengeService.
pub fn compose_product(cfg: &FloraConfig, pool: Option<PgPool>) -> ProductComposition {
    let mut background = Vec::new();

    let verification_port = if let Some(ref pool) = pool {
        if let Some(bundle) = flora_verification::compose(cfg, pool.clone()) {
            if let Some(h) = bundle.grpc_handle {
                background.push(h);
            }
            Some(bundle.port)
        } else {
            None
        }
    } else {
        None
    };

    if let Some(ref pool) = pool {
        background.extend(spawn_music_workers(cfg, pool.clone()));
    }

    let (auth_routes, account_directory) =
        auth_router_with_directory(cfg, pool.clone(), verification_port);

    let (notifications_routes, message_sent_notifier, notification_dispatcher) =
        notifications_router(cfg, pool.clone(), account_directory.clone());

    let (content_routes, content_workers) =
        content_router(cfg, pool.clone(), Arc::clone(&notification_dispatcher));
    background.extend(content_workers);
    let (users_routes, users_workers) = users_router(
        cfg,
        pool.clone(),
        account_directory.clone(),
        Arc::clone(&notification_dispatcher),
    );
    background.extend(users_workers);
    let (messaging_routes, messaging_workers) =
        messaging_router(cfg, pool.clone(), account_directory, message_sent_notifier);
    background.extend(messaging_workers);

    let (economy_routes, economy_workers) = economy_composition(cfg);
    background.extend(economy_workers);

    let router = axum::Router::new()
        .merge(users_routes)
        .merge(flora_verification::router())
        .merge(auth_routes)
        .merge(notifications_routes)
        .merge(content_routes)
        .merge(messaging_routes)
        .merge(music_router(cfg, pool))
        .merge(economy_routes);

    ProductComposition { router, background }
}

fn auth_router_with_directory(
    cfg: &FloraConfig,
    pool: Option<PgPool>,
    verification: Option<Arc<dyn VerificationChallengePort>>,
) -> (
    axum::Router,
    Option<Arc<dyn flora_auth_contracts::AccountDirectory>>,
) {
    if cfg.get_bool("Auth:ServeNative") != Some(true) {
        return (
            flora_auth::router(),
            pool.map(flora_auth::account_directory),
        );
    }
    let Some(pool) = pool else {
        eprintln!("flora-auth: Auth:ServeNative=true, но PgPool недоступен — модуль офлайн");
        return (flora_auth::router(), None);
    };
    let Some(verification) = verification else {
        eprintln!(
            "flora-auth: Auth:ServeNative=true, но VerificationBundle недоступен — модуль офлайн"
        );
        return (
            flora_auth::router(),
            Some(flora_auth::account_directory(pool)),
        );
    };
    let jwt = JwtOptions::from_config(cfg);
    let (profiles, provisioner) = flora_users::profile_ports(pool.clone());
    let module = flora_auth::compose(pool, jwt, profiles, provisioner, verification);
    let directory = module.account_directory.clone();
    let router = axum::Router::new()
        .merge(with_jwt(cfg, module.protected_router))
        .merge(module.public_router);
    (router, Some(directory))
}

fn users_router(
    cfg: &FloraConfig,
    pool: Option<PgPool>,
    accounts: Option<Arc<dyn flora_auth_contracts::AccountDirectory>>,
    notifications: Arc<dyn flora_notifications_contracts::UserNotificationDispatcher>,
) -> (axum::Router, Vec<BackgroundHandle>) {
    if cfg.get_bool("Users:ServeNative") != Some(true) {
        return (flora_users::router(), Vec::new());
    }
    let Some(pool) = pool else {
        eprintln!("flora-users: Users:ServeNative=true, но PgPool недоступен — модуль офлайн");
        return (flora_users::router(), Vec::new());
    };
    let Some(accounts) = accounts else {
        eprintln!("flora-users: нет AccountDirectory — модуль офлайн");
        return (flora_users::router(), Vec::new());
    };
    let communities = flora_content::community_follow_stats(pool.clone());
    let mut module = flora_users::compose(
        pool,
        accounts,
        communities,
        notifications,
        cfg.get_bool("Media:FrcI:BackfillEnabled") == Some(true),
    );
    let workers = module.image_backfill.take().into_iter().collect();
    let router = axum::Router::new()
        .merge(with_jwt(cfg, module.protected_router))
        .merge(with_optional_jwt(cfg, module.public_router));
    (router, workers)
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

fn notifications_router(
    cfg: &FloraConfig,
    pool: Option<PgPool>,
    accounts: Option<Arc<dyn flora_auth_contracts::AccountDirectory>>,
) -> (
    axum::Router,
    Arc<dyn flora_messaging_contracts::MessageSentNotifier>,
    Arc<dyn flora_notifications_contracts::UserNotificationDispatcher>,
) {
    let noop_msg: Arc<dyn flora_messaging_contracts::MessageSentNotifier> =
        Arc::new(flora_messaging_contracts::NoopMessageSentNotifier);
    let noop_inbox: Arc<dyn flora_notifications_contracts::UserNotificationDispatcher> =
        Arc::new(flora_notifications_contracts::NoopUserNotificationDispatcher);
    if cfg.get_bool("Notifications:ServeNative") != Some(true) {
        return (flora_notifications::router(), noop_msg, noop_inbox);
    }
    let Some(pool) = pool else {
        eprintln!(
            "flora-notifications: Notifications:ServeNative=true, но PgPool недоступен — модуль офлайн"
        );
        return (flora_notifications::router(), noop_msg, noop_inbox);
    };
    let Some(accounts) = accounts else {
        eprintln!(
            "flora-notifications: нет AccountDirectory — FCM display names недоступны, модуль офлайн"
        );
        return (flora_notifications::router(), noop_msg, noop_inbox);
    };
    let profiles = flora_users::profile_queries(pool.clone());
    let module = flora_notifications::compose(pool, cfg, profiles, accounts);
    let router = axum::Router::new()
        .merge(with_jwt(cfg, module.protected_router))
        .merge(module.admin_router);
    (
        router,
        module.message_sent_notifier,
        module.user_notification_dispatcher,
    )
}

fn messaging_router(
    cfg: &FloraConfig,
    pool: Option<PgPool>,
    accounts: Option<Arc<dyn flora_auth_contracts::AccountDirectory>>,
    sent_notifier: Arc<dyn flora_messaging_contracts::MessageSentNotifier>,
) -> (axum::Router, Vec<BackgroundHandle>) {
    if cfg.get_bool("Messaging:ServeNative") != Some(true) {
        return (flora_messaging::router(), Vec::new());
    }
    let Some(pool) = pool else {
        eprintln!(
            "flora-messaging: Messaging:ServeNative=true, но PgPool недоступен — модуль офлайн"
        );
        return (flora_messaging::router(), Vec::new());
    };
    let Some(accounts) = accounts else {
        eprintln!("flora-messaging: нет AccountDirectory — модуль офлайн");
        return (flora_messaging::router(), Vec::new());
    };
    let (presence, profiles, online, messages_access) = flora_users::messaging_ports(pool.clone());
    // Секрет E2E proof-токенов: выделенный ключ или fallback на Jwt:Secret
    // (внутри модуля MAC-ключ доменно-разделяется HMAC'ом, cross-use с JWT исключён).
    let e2e_token_secret = cfg
        .get_non_empty("Messaging:E2eTokenSecret")
        .or_else(|| cfg.get_non_empty("Jwt:Secret"))
        .map(|s| s.as_bytes().to_vec());
    let module = flora_messaging::compose(
        pool,
        accounts,
        profiles,
        presence,
        online,
        messages_access,
        sent_notifier,
        e2e_token_secret,
    );
    (with_jwt(cfg, module.router), vec![module.asset_cleanup])
}

fn content_router(
    cfg: &FloraConfig,
    pool: Option<PgPool>,
    notifications: Arc<dyn flora_notifications_contracts::UserNotificationDispatcher>,
) -> (axum::Router, Vec<BackgroundHandle>) {
    if cfg.get_bool("Content:ServeNative") != Some(true) {
        return (flora_content::router(), Vec::new());
    }
    let Some(pool) = pool else {
        eprintln!("flora-content: Content:ServeNative=true, но PgPool недоступен — модуль офлайн");
        return (flora_content::router(), Vec::new());
    };
    let accounts = flora_auth::account_directory(pool.clone());
    let (follow, blocklist, profiles) = flora_users::content_ports(pool.clone());
    let profile_access = flora_users::profile_access_port(pool.clone());
    let user_avatars = flora_users::avatar_media_port(pool.clone());
    let media = flora_content::ContentMediaOptions {
        ffmpeg_path: cfg
            .get_non_empty("Media:FfmpegPath")
            .unwrap_or("ffmpeg")
            .to_string(),
        ffprobe_path: cfg.get("Media:FfprobePath").unwrap_or("").to_string(),
        frc_i_backfill_enabled: cfg.get_bool("Media:FrcI:BackfillEnabled") == Some(true),
    };
    let mut module = flora_content::compose(
        pool,
        accounts,
        follow,
        blocklist,
        profiles,
        profile_access,
        user_avatars,
        media,
        notifications,
    );
    // Dual-writer запрещён: при ServeNative воркер post_videos крутит Rust.
    let mut workers = Vec::new();
    if let Some(h) = flora_content::take_and_spawn_video_worker(&mut module) {
        workers.push(h);
    }
    if let Some(h) = flora_content::take_image_backfill(&mut module) {
        workers.push(h);
    }
    let router = axum::Router::new()
        .merge(with_jwt(cfg, module.protected_router))
        .merge(with_optional_jwt(cfg, module.public_router));
    (router, workers)
}

fn with_optional_jwt(cfg: &FloraConfig, router: axum::Router) -> axum::Router {
    let jwt = JwtAuthLayerState::from_config(cfg);
    router.layer(axum::middleware::from_fn_with_state(
        jwt_layer::JwtAuthState {
            options: jwt.options,
        },
        jwt_layer::optional_bearer_jwt,
    ))
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

/// Economy (FEP/LIV): роутер + фоновый демерредж-воркер.
///
/// Конфиг: `Economy:Enabled`, `Economy:LedgerPath`, `Economy:Witnesses` (массив hex-ключей
/// Ed25519), `Economy:DemurrageSweepMinutes` (0 = воркер выключен). Косайны витнессов
/// живут в sidecar-файле `<LedgerPath>.cosigns.jsonl` рядом с журналом.
fn economy_composition(cfg: &FloraConfig) -> (axum::Router, Vec<BackgroundHandle>) {
    if cfg.get_bool("Economy:Enabled") != Some(true) {
        return (flora_economy::router(), Vec::new());
    }
    let path = cfg
        .get_non_empty("Economy:LedgerPath")
        .unwrap_or("flora-economy.ledger.jsonl");
    let store = std::sync::Arc::new(flora_economy::infrastructure::JsonlLedgerStore::new(
        std::path::PathBuf::from(path),
    ));
    let cosign_store = std::sync::Arc::new(flora_economy::infrastructure::JsonlCosignStore::new(
        std::path::PathBuf::from(format!("{path}.cosigns.jsonl")),
    ));
    let mut witnesses = Vec::new();
    for hex in cfg.get_string_array("Economy:Witnesses") {
        match parse_witness_key(&hex) {
            Some(key) => witnesses.push(key),
            None => eprintln!(
                "flora-economy: Economy:Witnesses содержит не hex-ключ Ed25519 (64 символа), пропущен: {hex}"
            ),
        }
    }
    let attestor = std::sync::Arc::new(flora_economy::infrastructure::ConservativeAttestor);
    match flora_economy::compose(store, cosign_store, witnesses, attestor) {
        Ok(module) => {
            let mut workers = Vec::new();
            let minutes = cfg.get_i64("Economy:DemurrageSweepMinutes").unwrap_or(60);
            if minutes > 0 {
                workers.push(flora_economy::spawn_demurrage_worker(
                    module.service.clone(),
                    std::time::Duration::from_secs(minutes as u64 * 60),
                ));
            }
            (module.router, workers)
        }
        Err(e) => {
            eprintln!("flora-economy: композиция отклонена, модуль офлайн: {e}");
            (flora_economy::router(), Vec::new())
        }
    }
}

/// Hex → 32-байтовый ключ витнесса; `None` при неверной длине или не-hex символах.
fn parse_witness_key(hex: &str) -> Option<[u8; 32]> {
    let hex = hex.trim();
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
    }
    Some(out)
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

pub fn users_needs_pool(cfg: &FloraConfig) -> bool {
    cfg.get_bool("Users:ServeNative") == Some(true)
}

pub fn content_needs_pool(cfg: &FloraConfig) -> bool {
    cfg.get_bool("Content:ServeNative") == Some(true)
}

pub fn messaging_needs_pool(cfg: &FloraConfig) -> bool {
    cfg.get_bool("Messaging:ServeNative") == Some(true)
}

pub fn notifications_needs_pool(cfg: &FloraConfig) -> bool {
    cfg.get_bool("Notifications:ServeNative") == Some(true)
}

pub fn verification_needs_pool(cfg: &FloraConfig) -> bool {
    flora_verification::needs_pool(cfg)
}

/// Нужен ли PgPool хосту (Music/Auth/Users/Content/Messaging/Notifications ServeNative и/или Verification gRPC).
pub fn host_needs_pool(cfg: &FloraConfig) -> bool {
    music_needs_pool(cfg)
        || auth_needs_pool(cfg)
        || users_needs_pool(cfg)
        || content_needs_pool(cfg)
        || messaging_needs_pool(cfg)
        || notifications_needs_pool(cfg)
        || verification_needs_pool(cfg)
}

/// Фоновые задачи продукта (Music / Content video workers, Verification gRPC, …).
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

/// Фоновые задачи без роутера. Не использовать вместе с [`compose_product`] —
/// иначе Verification ChallengeService создаётся дважды.
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

    #[tokio::test]
    async fn messaging_serve_native_without_pool_stays_empty() {
        let cfg = FloraConfig::from_layers(
            "Development",
            &[serde_json::json!({ "Messaging": { "ServeNative": true } })],
            &[],
        );
        let router = product_router(&cfg, None);
        let response = router
            .oneshot(
                http::Request::builder()
                    .uri("/api/messaging/unread-count")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn content_serve_native_without_pool_stays_empty() {
        let cfg = FloraConfig::from_layers(
            "Development",
            &[serde_json::json!({ "Content": { "ServeNative": true } })],
            &[],
        );
        let router = product_router(&cfg, None);
        let response = router
            .oneshot(
                http::Request::builder()
                    .uri("/api/auth/feed")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn notifications_serve_native_without_pool_stays_empty() {
        let cfg = FloraConfig::from_layers(
            "Development",
            &[serde_json::json!({ "Notifications": { "ServeNative": true } })],
            &[],
        );
        let router = product_router(&cfg, None);
        let response = router
            .oneshot(
                http::Request::builder()
                    .uri("/api/auth/notifications/unread-count")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), http::StatusCode::NOT_FOUND);
    }
}
