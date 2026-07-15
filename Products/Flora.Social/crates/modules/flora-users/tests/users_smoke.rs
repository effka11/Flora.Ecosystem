//! Smoke Users me/privacy/blocks/follow/search (flora-api + Users:ServeNative + Auth:ServeNative).
//!
//! ```powershell
//! $env:FLORA_USERS_SMOKE=1
//! # optional follow roundtrip target (must not be self):
//! $env:FLORA_USERS_SMOKE_TARGET_USERNAME="other_user"
//! cargo test -p flora-users --test users_smoke -- --nocapture --test-threads=1
//! ```

use std::path::PathBuf;
use std::time::Duration;

use flora_auth::infrastructure::jwt::{AccessTokenClaims, JwtOptions, issue_access_token};
use flora_shared::config::FloraConfig;
use flora_shared::npgsql::NpgsqlConnectionString;
use sqlx::PgPool;
use sqlx::postgres::PgConnectOptions;
use uuid::Uuid;

fn gateway(path: &str) -> String {
    format!("http://127.0.0.1:5290{path}")
}

fn smoke_user_uuid() -> Uuid {
    let s = std::env::var("FLORA_AUTH_SMOKE_USER")
        .unwrap_or_else(|_| "019e9ee8-e522-7fe5-90bb-8d1084f60366".into());
    Uuid::parse_str(&s).expect("uuid")
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
    FloraConfig::load("Development", &path).expect("config")
}

async fn connect_pool(cfg: &FloraConfig) -> PgPool {
    let raw = cfg
        .get_non_empty("ConnectionStrings:FloraDatabase")
        .expect("db");
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
        .expect("pool")
}

fn mint_bearer(secret: String, user: Uuid) -> String {
    let mut options = JwtOptions::from_config(&FloraConfig::default());
    options.secret = secret;
    let now = chrono::Utc::now().timestamp();
    issue_access_token(
        &options,
        &AccessTokenClaims {
            sub: user.to_string(),
            email: "smoke@flora.local".into(),
            jti: Uuid::now_v7().to_string(),
            expires_at: now + 3600,
        },
    )
}

#[tokio::test]
async fn get_me_and_privacy() {
    if std::env::var("FLORA_USERS_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_USERS_SMOKE=1");
        return;
    }
    let secret = load_dev_jwt_secret().expect("jwt secret");
    let user = smoke_user_uuid();
    let token = mint_bearer(secret, user);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("client");

    let me = client
        .get(gateway("/api/auth/me"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .expect("GET me");
    let me_status = me.status();
    let me_body: serde_json::Value = me.json().await.expect("json");
    assert_eq!(me_status, reqwest::StatusCode::OK, "{me_body}");
    assert_eq!(me_body["userUuid"], user.to_string());
    assert!(me_body["username"].as_str().is_some());
    assert!(me_body.get("followersCount").is_some());
    assert!(me_body.get("followingCount").is_some());

    let privacy = client
        .get(gateway("/api/auth/me/privacy"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .expect("GET privacy");
    let privacy_status = privacy.status();
    let privacy_body: serde_json::Value = privacy.json().await.expect("json");
    assert_eq!(privacy_status, reqwest::StatusCode::OK, "{privacy_body}");
    assert!(privacy_body.get("friendsVisibility").is_some());
    assert!(privacy_body.get("onlineStrangers").is_some());

    let blocks = client
        .get(gateway("/api/auth/me/blocks"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .expect("GET blocks");
    assert_eq!(blocks.status(), reqwest::StatusCode::OK);

    let patch = client
        .patch(gateway("/api/auth/profile"))
        .header("Authorization", format!("Bearer {token}"))
        .json(&serde_json::json!({ "status": "smoke-profile" }))
        .send()
        .await
        .expect("PATCH profile");
    let patch_status = patch.status();
    let patch_body: serde_json::Value = patch.json().await.expect("json");
    assert_eq!(patch_status, reqwest::StatusCode::OK, "{patch_body}");
    assert_eq!(patch_body["message"], "Профиль обновлён.");

    // ensure pool reachable (smoke env sanity)
    let _ = connect_pool(&load_config()).await;
}

#[tokio::test]
async fn search_and_follow_roundtrip() {
    if std::env::var("FLORA_USERS_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_USERS_SMOKE=1");
        return;
    }
    let secret = load_dev_jwt_secret().expect("jwt secret");
    let user = smoke_user_uuid();
    let token = mint_bearer(secret, user);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("client");

    let search = client
        .get(gateway("/api/auth/users/search?q=a&take=5"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .expect("GET search");
    let search_status = search.status();
    let search_body: serde_json::Value = search.json().await.expect("json");
    assert_eq!(search_status, reqwest::StatusCode::OK, "{search_body}");
    assert!(search_body.is_array());

    let target_username = std::env::var("FLORA_USERS_SMOKE_TARGET_USERNAME").ok().or_else(|| {
        search_body
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|row| row["username"].as_str())
            .map(str::to_string)
    });
    let Some(target_username) = target_username else {
        eprintln!("skip follow roundtrip: no FLORA_USERS_SMOKE_TARGET_USERNAME and empty search");
        return;
    };

    let follow = client
        .post(gateway(&format!(
            "/api/auth/profile/{target_username}/follow"
        )))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .expect("POST follow");
    let follow_status = follow.status();
    let follow_body: serde_json::Value = follow.json().await.expect("json");
    assert!(
        follow_status == reqwest::StatusCode::OK
            && (follow_body["message"] == "Подписка оформлена."
                || follow_body["message"] == "Уже подписаны."),
        "{follow_status} {follow_body}"
    );

    let unfollow = client
        .delete(gateway(&format!(
            "/api/auth/profile/{target_username}/follow"
        )))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .expect("DELETE unfollow");
    let unfollow_status = unfollow.status();
    if unfollow_status == reqwest::StatusCode::NO_CONTENT {
        return;
    }
    let unfollow_body: serde_json::Value = unfollow.json().await.expect("json");
    assert_eq!(unfollow_status, reqwest::StatusCode::OK, "{unfollow_body}");
    assert_eq!(unfollow_body["message"], "Подписки не было.");
}
