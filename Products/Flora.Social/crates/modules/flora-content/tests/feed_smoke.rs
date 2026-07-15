//! Локальный smoke Content feed (нужен flora-api с Content:ServeNative):
//! GET /api/auth/feed, GET /api/auth/feed/has-new, POST /api/auth/posts.
//!
//! ```powershell
//! $env:FLORA_CONTENT_SMOKE=1
//! cargo test -p flora-content --test feed_smoke -- --nocapture --test-threads=1
//! ```

use std::path::PathBuf;
use std::time::Duration;

use chrono::{Duration as ChronoDuration, Utc};
use flora_auth::infrastructure::jwt::{AccessTokenClaims, JwtOptions, issue_access_token};
use flora_shared::config::FloraConfig;
use flora_shared::npgsql::NpgsqlConnectionString;
use sqlx::PgPool;
use sqlx::postgres::PgConnectOptions;
use uuid::Uuid;

fn gateway_feed_url() -> String {
    std::env::var("FLORA_CONTENT_FEED_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:5290/api/auth/feed".into())
}

fn gateway_has_new_url() -> String {
    std::env::var("FLORA_CONTENT_HAS_NEW_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:5290/api/auth/feed/has-new".into())
}

fn gateway_posts_url() -> String {
    std::env::var("FLORA_CONTENT_POSTS_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:5290/api/auth/posts".into())
}

fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn load_dev_jwt_secret() -> Option<String> {
    if let Ok(s) = std::env::var("Jwt__Secret")
        && !s.is_empty()
    {
        return Some(s);
    }
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for _ in 0..5 {
        path.pop();
    }
    path.push(".flora");
    path.push("dev-jwt.secret");
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
}

fn load_config() -> FloraConfig {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for _ in 0..5 {
        path.pop();
    }
    path.push("Backend");
    FloraConfig::load("Development", &path).expect("load Backend/appsettings")
}

async fn connect_pool(cfg: &FloraConfig) -> PgPool {
    let raw = cfg
        .get_non_empty("ConnectionStrings:FloraDatabase")
        .expect("ConnectionStrings:FloraDatabase");
    let parsed = NpgsqlConnectionString::parse(raw).expect("npgsql");
    let mut options = PgConnectOptions::new()
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
    if let Some(search_path) = &parsed.search_path {
        options = options.options([("search_path", search_path.as_str())]);
    }
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect_with(options)
        .await
        .expect("pg connect")
}

async fn pick_user(pool: &PgPool) -> Uuid {
    if let Ok(s) = std::env::var("FLORA_CONTENT_SMOKE_USER") {
        return Uuid::parse_str(&s).expect("FLORA_CONTENT_SMOKE_USER uuid");
    }
    let uuid: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT user_uuid FROM flora_core.user_accounts
        ORDER BY created_at DESC NULLS LAST
        LIMIT 1
        "#,
    )
    .fetch_optional(pool)
    .await
    .expect("pick user");
    uuid.expect("need at least one user_accounts row for content smoke")
}

fn bearer(cfg: &FloraConfig, user_uuid: Uuid) -> String {
    let mut jwt = JwtOptions::from_config(cfg);
    if jwt.secret.is_empty() {
        if let Some(s) = load_dev_jwt_secret() {
            jwt.secret = s;
        }
    }
    let now = Utc::now().timestamp();
    let token = issue_access_token(
        &jwt,
        &AccessTokenClaims {
            sub: user_uuid.to_string(),
            email: "content-smoke@flora.local".into(),
            jti: Uuid::now_v7().to_string(),
            expires_at: now + 60 * 15,
        },
    );
    format!("Bearer {token}")
}

#[tokio::test]
async fn feed_has_new_and_create_post_smoke() {
    if std::env::var("FLORA_CONTENT_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_CONTENT_SMOKE=1");
        return;
    }

    let cfg = load_config();
    let pool = connect_pool(&cfg).await;
    let user = pick_user(&pool).await;
    let auth = bearer(&cfg, user);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();

    let feed = client
        .get(format!("{}?take=5&kind=subscriptions", gateway_feed_url()))
        .header("Authorization", &auth)
        .send()
        .await
        .expect("GET feed — is flora-api running with Content:ServeNative?");
    assert_eq!(feed.status(), 200, "feed status {}", feed.status());
    let feed_json: serde_json::Value = feed.json().await.expect("feed json");
    assert!(feed_json.get("items").is_some());
    assert!(feed_json.get("hasMore").is_some());

    let since = (Utc::now() - ChronoDuration::days(30)).to_rfc3339();
    let has_new = client
        .get(format!(
            "{}?since={}",
            gateway_has_new_url(),
            urlencoding_encode(&since)
        ))
        .header("Authorization", &auth)
        .send()
        .await
        .expect("GET has-new");
    assert_eq!(has_new.status(), 200, "has-new {}", has_new.status());
    let has_new_json: serde_json::Value = has_new.json().await.expect("has-new json");
    assert!(has_new_json.get("hasNew").is_some());
    assert!(has_new_json.get("checkedAt").is_some());

    let create = client
        .post(gateway_posts_url())
        .header("Authorization", &auth)
        .json(&serde_json::json!({
            "content": format!("flora-content smoke {}", Uuid::now_v7())
        }))
        .send()
        .await
        .expect("POST posts");
    assert_eq!(create.status(), 200, "create {}", create.status());
    let created: serde_json::Value = create.json().await.expect("create json");
    assert!(created.get("postUuid").is_some());
    assert!(created.get("createdAt").is_some());
}
