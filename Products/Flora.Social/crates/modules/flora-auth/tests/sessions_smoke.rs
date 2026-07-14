//! Локальный smoke GET /api/auth/me/sessions (нужен flora-api с Auth:ServeNative).
//!
//! ```powershell
//! $env:FLORA_AUTH_SESSIONS_SMOKE=1
//! cargo test -p flora-auth --test sessions_smoke -- --nocapture
//! ```

use std::path::PathBuf;
use std::time::Duration;

use flora_auth::infrastructure::jwt::{AccessTokenClaims, JwtOptions, issue_access_token};

fn gateway_sessions_url() -> String {
    std::env::var("FLORA_AUTH_SESSIONS_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:5290/api/auth/me/sessions".into())
}

fn load_dev_jwt_secret() -> Option<String> {
    if let Ok(s) = std::env::var("Jwt__Secret")
        && !s.is_empty()
    {
        return Some(s);
    }
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // modules/flora-auth → repo root
    for _ in 0..5 {
        path.pop();
    }
    path.push(".flora");
    path.push("dev-jwt.secret");
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
}

#[tokio::test]
async fn sessions_unauthorized_without_bearer() {
    if std::env::var("FLORA_AUTH_SESSIONS_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_AUTH_SESSIONS_SMOKE=1");
        return;
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("client");
    let res = client
        .get(gateway_sessions_url())
        .send()
        .await
        .expect("GET sessions — is flora-api running with Auth:ServeNative?");
    assert_eq!(res.status(), reqwest::StatusCode::UNAUTHORIZED);
    let body: serde_json::Value = res.json().await.expect("json");
    assert_eq!(
        body["error"].as_str(),
        Some("Не удалось определить пользователя.")
    );
}

#[tokio::test]
async fn sessions_list_shape_with_minted_bearer() {
    if std::env::var("FLORA_AUTH_SESSIONS_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_AUTH_SESSIONS_SMOKE=1");
        return;
    }
    let secret = load_dev_jwt_secret().expect(".flora/dev-jwt.secret or Jwt__Secret");
    let user = std::env::var("FLORA_AUTH_SMOKE_USER")
        .unwrap_or_else(|_| "019e9ee8-e522-7fe5-90bb-8d1084f60366".into());
    let jti = std::env::var("FLORA_AUTH_SMOKE_JTI")
        .unwrap_or_else(|_| "019f62099e3c756d90a1bc284b495ab1".into());

    let mut options = JwtOptions::from_config(&flora_shared::config::FloraConfig::default());
    options.secret = secret;
    let now = chrono::Utc::now().timestamp();
    let token = issue_access_token(
        &options,
        &AccessTokenClaims {
            sub: user,
            email: "smoke@flora.local".into(),
            jti: jti.clone(),
            expires_at: now + 900,
        },
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("client");
    let res = client
        .get(gateway_sessions_url())
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET sessions with bearer");
    let status = res.status();
    let body: serde_json::Value = res.json().await.expect("json");
    assert_eq!(status, reqwest::StatusCode::OK, "body {body}");
    let arr = body.as_array().expect("array");
    assert!(!arr.is_empty(), "expected at least one active session");
    let first = &arr[0];
    for key in [
        "sessionId",
        "createdAt",
        "lastActivity",
        "ipAddress",
        "city",
        "countryCode",
        "isCurrent",
    ] {
        assert!(first.get(key).is_some(), "missing {key} in {first}");
    }
    let matched: Vec<_> = arr.iter().filter(|s| s["isCurrent"] == true).collect();
    assert_eq!(matched.len(), 1, "isCurrent for jti={jti}: {body}");
}
