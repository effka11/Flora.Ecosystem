//! Локальный smoke Auth sessions (нужен flora-api с Auth:ServeNative):
//! GET/DELETE sessions*, POST /api/auth/logout.
//!
//! При отсутствии активных сессий smoke сам вставляет строки в `user_sessions`
//! (не логин через C#) — чтобы не зависеть от пароля и не оставлять «битый» jti.
//!
//! ```powershell
//! $env:FLORA_AUTH_SESSIONS_SMOKE=1
//! cargo test -p flora-auth --test sessions_smoke -- --nocapture --test-threads=1
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

fn gateway_sessions_url() -> String {
    std::env::var("FLORA_AUTH_SESSIONS_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:5290/api/auth/me/sessions".into())
}

fn gateway_revoke_others_url() -> String {
    std::env::var("FLORA_AUTH_REVOKE_OTHERS_URL").unwrap_or_else(|_| {
        "http://127.0.0.1:5290/api/auth/me/sessions/others".into()
    })
}

fn gateway_logout_url() -> String {
    std::env::var("FLORA_AUTH_LOGOUT_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:5290/api/auth/logout".into())
}

fn gateway_security_url() -> String {
    std::env::var("FLORA_AUTH_SECURITY_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:5290/api/auth/me/security".into())
}

fn gateway_refresh_url() -> String {
    std::env::var("FLORA_AUTH_REFRESH_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:5290/api/auth/refresh".into())
}

fn gateway_login_url() -> String {
    std::env::var("FLORA_AUTH_LOGIN_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:5290/api/auth/login".into())
}

fn gateway_register_url() -> String {
    std::env::var("FLORA_AUTH_REGISTER_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:5290/api/auth/register".into())
}

fn gateway_verify_registration_url() -> String {
    std::env::var("FLORA_AUTH_VERIFY_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:5290/api/auth/verify-registration".into())
}

fn gateway_cancel_registration_url() -> String {
    std::env::var("FLORA_AUTH_CANCEL_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:5290/api/auth/cancel-registration".into())
}

fn smoke_user_uuid() -> Uuid {
    let s = std::env::var("FLORA_AUTH_SMOKE_USER")
        .unwrap_or_else(|_| "019e9ee8-e522-7fe5-90bb-8d1084f60366".into());
    Uuid::parse_str(&s).expect("FLORA_AUTH_SMOKE_USER uuid")
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
        .expect("connect postgres")
}

async fn count_active(pool: &PgPool, user_uuid: Uuid) -> i64 {
    sqlx::query_scalar(
        r#"
        SELECT count(*)::bigint
        FROM flora_core.user_sessions
        WHERE user_uuid = $1 AND status = 0 AND expires_at > now()
        "#,
    )
    .bind(user_uuid)
    .fetch_one(pool)
    .await
    .expect("count active")
}

async fn insert_active_session(pool: &PgPool, user_uuid: Uuid) -> String {
    let session_id = Uuid::now_v7();
    let jwt_id = Uuid::now_v7().to_string();
    let refresh = format!("smoke-refresh-{session_id}");
    let now = Utc::now();
    let expires = now + ChronoDuration::days(7);
    sqlx::query(
        r#"
        INSERT INTO flora_core.user_sessions (
            session_id, user_uuid, agent_hash, ip_address,
            created_at, expires_at, last_activity,
            jwt_id, refresh_token, rotation_id, status,
            csrf_token, hmac_key
        ) VALUES (
            $1, $2, 'smoke', '127.0.0.1',
            $3, $4, $3,
            $5, $6, 0, 0,
            'smoke-csrf', 'smoke-hmac'
        )
        "#,
    )
    .bind(session_id)
    .bind(user_uuid)
    .bind(now)
    .bind(expires)
    .bind(&jwt_id)
    .bind(refresh)
    .execute(pool)
    .await
    .expect("insert smoke session");
    jwt_id
}

/// Гарантирует ≥ `min` активных сессий; возвращает jwt_id самой свежей.
async fn ensure_active_sessions(pool: &PgPool, user_uuid: Uuid, min: usize) -> String {
    while (count_active(pool, user_uuid).await as usize) < min {
        let _ = insert_active_session(pool, user_uuid).await;
    }
    sqlx::query_scalar::<_, String>(
        r#"
        SELECT jwt_id
        FROM flora_core.user_sessions
        WHERE user_uuid = $1 AND status = 0 AND expires_at > now()
        ORDER BY last_activity DESC
        LIMIT 1
        "#,
    )
    .bind(user_uuid)
    .fetch_one(pool)
    .await
    .expect("latest jwt_id")
}

fn mint_bearer(secret: String, user: Uuid, jti: &str) -> String {
    let mut options = JwtOptions::from_config(&FloraConfig::default());
    options.secret = secret;
    let now = chrono::Utc::now().timestamp();
    issue_access_token(
        &options,
        &AccessTokenClaims {
            sub: user.to_string(),
            email: "smoke@flora.local".into(),
            jti: jti.into(),
            expires_at: now + 900,
        },
    )
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
    let user = smoke_user_uuid();
    let cfg = load_config();
    let pool = connect_pool(&cfg).await;
    let jti = ensure_active_sessions(&pool, user, 1).await;
    let token = mint_bearer(secret, user, &jti);

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

#[tokio::test]
async fn revoke_others_unauthorized_without_bearer() {
    if std::env::var("FLORA_AUTH_SESSIONS_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_AUTH_SESSIONS_SMOKE=1");
        return;
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("client");
    let res = client
        .delete(gateway_revoke_others_url())
        .send()
        .await
        .expect("DELETE sessions/others — is flora-api running with Auth:ServeNative?");
    assert_eq!(res.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn revoke_others_keeps_current_session() {
    if std::env::var("FLORA_AUTH_SESSIONS_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_AUTH_SESSIONS_SMOKE=1");
        return;
    }
    let secret = load_dev_jwt_secret().expect(".flora/dev-jwt.secret or Jwt__Secret");
    let user = smoke_user_uuid();
    let cfg = load_config();
    let pool = connect_pool(&cfg).await;
    // Две активные: текущая + «чужая».
    let jti = ensure_active_sessions(&pool, user, 2).await;
    let token = mint_bearer(secret, user, &jti);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("client");

    let before = client
        .get(gateway_sessions_url())
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET before revoke")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    let before_count = before.as_array().map(|a| a.len()).unwrap_or(0);
    assert!(before_count >= 2, "expected ≥2 sessions before revoke: {before}");

    let res = client
        .delete(gateway_revoke_others_url())
        .bearer_auth(&token)
        .send()
        .await
        .expect("DELETE sessions/others with bearer");
    let status = res.status();
    let body: serde_json::Value = res.json().await.expect("json");
    assert_eq!(status, reqwest::StatusCode::OK, "body {body}");
    let revoked = body["revoked"].as_u64().expect("revoked count");
    assert_eq!(
        revoked,
        before_count.saturating_sub(1) as u64,
        "revoked others only: before={before_count} body={body}"
    );

    let after = client
        .get(gateway_sessions_url())
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET after revoke")
        .json::<serde_json::Value>()
        .await
        .expect("json");
    let after_arr = after.as_array().expect("array");
    assert_eq!(after_arr.len(), 1, "only current session remains: {after}");
    assert_eq!(after_arr[0]["isCurrent"], true);
}

#[tokio::test]
async fn logout_unauthorized_without_bearer() {
    if std::env::var("FLORA_AUTH_SESSIONS_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_AUTH_SESSIONS_SMOKE=1");
        return;
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("client");
    let res = client
        .post(gateway_logout_url())
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("POST logout — is flora-api running with Auth:ServeNative?");
    assert_eq!(res.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn logout_revokes_current_session() {
    if std::env::var("FLORA_AUTH_SESSIONS_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_AUTH_SESSIONS_SMOKE=1");
        return;
    }
    let secret = load_dev_jwt_secret().expect(".flora/dev-jwt.secret or Jwt__Secret");
    let user = smoke_user_uuid();
    let cfg = load_config();
    let pool = connect_pool(&cfg).await;
    let jti = ensure_active_sessions(&pool, user, 1).await;
    let token = mint_bearer(secret, user, &jti);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("client");

    let res = client
        .post(gateway_logout_url())
        .bearer_auth(&token)
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("POST logout with bearer");
    assert_eq!(res.status(), reqwest::StatusCode::OK);
    let body = res.text().await.expect("body");
    assert!(
        body.is_empty() || body == "null",
        "logout should be empty 200, got {body:?}"
    );

    let status: i32 = sqlx::query_scalar(
        "SELECT status FROM flora_core.user_sessions WHERE jwt_id = $1",
    )
    .bind(&jti)
    .fetch_one(&pool)
    .await
    .expect("session status");
    assert_eq!(status, 4, "RevokedUser after logout");
}

#[tokio::test]
async fn security_unauthorized_without_bearer() {
    if std::env::var("FLORA_AUTH_SESSIONS_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_AUTH_SESSIONS_SMOKE=1");
        return;
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("client");
    let res = client
        .get(gateway_security_url())
        .send()
        .await
        .expect("GET me/security — is flora-api running with Auth:ServeNative?");
    assert_eq!(res.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn security_status_shape_with_minted_bearer() {
    if std::env::var("FLORA_AUTH_SESSIONS_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_AUTH_SESSIONS_SMOKE=1");
        return;
    }
    let secret = load_dev_jwt_secret().expect(".flora/dev-jwt.secret or Jwt__Secret");
    let user = smoke_user_uuid();
    let cfg = load_config();
    let pool = connect_pool(&cfg).await;
    let jti = ensure_active_sessions(&pool, user, 1).await;
    let token = mint_bearer(secret, user, &jti);

    let expected = sqlx::query_as::<_, (bool, bool, bool)>(
        r#"
        SELECT two_factor_enabled, email_verified, phone_verified
        FROM flora_core.user_accounts
        WHERE user_uuid = $1
        "#,
    )
    .bind(user)
    .fetch_optional(&pool)
    .await
    .expect("account flags")
    .unwrap_or((false, false, false));

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("client");
    let res = client
        .get(gateway_security_url())
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET me/security with bearer");
    let status = res.status();
    let body: serde_json::Value = res.json().await.expect("json");
    assert_eq!(status, reqwest::StatusCode::OK, "body {body}");
    assert_eq!(body["twoFactorEnabled"], expected.0);
    assert_eq!(body["emailVerified"], expected.1);
    assert_eq!(body["phoneVerified"], expected.2);
}

#[tokio::test]
async fn refresh_empty_token_is_bad_request() {
    if std::env::var("FLORA_AUTH_SESSIONS_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_AUTH_SESSIONS_SMOKE=1");
        return;
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("client");
    let res = client
        .post(gateway_refresh_url())
        .json(&serde_json::json!({ "refreshToken": "" }))
        .send()
        .await
        .expect("POST refresh");
    assert_eq!(res.status(), reqwest::StatusCode::BAD_REQUEST);
    let body: serde_json::Value = res.json().await.expect("json");
    assert_eq!(body["error"], "Refresh token is required.");
}

#[tokio::test]
async fn refresh_invalid_token_is_unauthorized() {
    if std::env::var("FLORA_AUTH_SESSIONS_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_AUTH_SESSIONS_SMOKE=1");
        return;
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("client");
    let res = client
        .post(gateway_refresh_url())
        .json(&serde_json::json!({ "refreshToken": "not-a-real-refresh-token" }))
        .send()
        .await
        .expect("POST refresh");
    assert_eq!(res.status(), reqwest::StatusCode::UNAUTHORIZED);
    let body: serde_json::Value = res.json().await.expect("json");
    assert_eq!(body["error"], "Invalid or expired refresh token.");
}

#[tokio::test]
async fn refresh_rotates_active_session() {
    if std::env::var("FLORA_AUTH_SESSIONS_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_AUTH_SESSIONS_SMOKE=1");
        return;
    }
    let user = smoke_user_uuid();
    let cfg = load_config();
    let pool = connect_pool(&cfg).await;
    let _ = ensure_active_sessions(&pool, user, 1).await;

    let (session_id, old_refresh, old_rotation): (Uuid, String, i64) = sqlx::query_as(
        r#"
        SELECT session_id, refresh_token, rotation_id
        FROM flora_core.user_sessions
        WHERE user_uuid = $1 AND status = 0 AND expires_at > now()
        ORDER BY last_activity DESC
        LIMIT 1
        "#,
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .expect("active session for refresh");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("client");
    let res = client
        .post(gateway_refresh_url())
        .json(&serde_json::json!({ "refreshToken": old_refresh }))
        .send()
        .await
        .expect("POST refresh with valid token");
    let status = res.status();
    let body: serde_json::Value = res.json().await.expect("json");
    assert_eq!(status, reqwest::StatusCode::OK, "body {body}");
    assert!(body["accessToken"].as_str().is_some_and(|s| !s.is_empty()));
    let new_refresh = body["refreshToken"].as_str().expect("refreshToken");
    assert_ne!(new_refresh, old_refresh);
    assert_eq!(body["tokenType"], "Bearer");
    assert!(body.get("expiresAt").is_some());
    assert!(body.get("requiresProfileCompletion").is_some());

    let (db_refresh, db_rotation): (String, i64) = sqlx::query_as(
        "SELECT refresh_token, rotation_id FROM flora_core.user_sessions WHERE session_id = $1",
    )
    .bind(session_id)
    .fetch_one(&pool)
    .await
    .expect("rotated row");
    assert_eq!(db_refresh, new_refresh);
    assert_eq!(db_rotation, old_rotation + 1);
}

#[tokio::test]
async fn login_missing_password_is_bad_request() {
    if std::env::var("FLORA_AUTH_SESSIONS_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_AUTH_SESSIONS_SMOKE=1");
        return;
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("client");
    let res = client
        .post(gateway_login_url())
        .json(&serde_json::json!({ "email": "x@y.z", "password": "" }))
        .send()
        .await
        .expect("POST login");
    assert_eq!(res.status(), reqwest::StatusCode::BAD_REQUEST);
    let body: serde_json::Value = res.json().await.expect("json");
    assert_eq!(body["error"], "Пароль обязателен.");
}

#[tokio::test]
async fn login_wrong_password_is_unauthorized() {
    if std::env::var("FLORA_AUTH_SESSIONS_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_AUTH_SESSIONS_SMOKE=1");
        return;
    }
    let user = smoke_user_uuid();
    let cfg = load_config();
    let pool = connect_pool(&cfg).await;
    let email: Option<String> = sqlx::query_scalar(
        "SELECT email FROM flora_core.user_accounts WHERE user_uuid = $1",
    )
    .bind(user)
    .fetch_optional(&pool)
    .await
    .expect("email")
    .flatten();
    let Some(email) = email.filter(|e| !e.is_empty()) else {
        eprintln!("skip: smoke user has no email");
        return;
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("client");
    let res = client
        .post(gateway_login_url())
        .json(&serde_json::json!({
            "email": email,
            "password": "definitely-wrong-password-for-smoke"
        }))
        .send()
        .await
        .expect("POST login wrong password");
    assert_eq!(res.status(), reqwest::StatusCode::UNAUTHORIZED);
    let body: serde_json::Value = res.json().await.expect("json");
    assert_eq!(body["error"], "Неверный email или пароль.");
}

#[tokio::test]
async fn login_success_with_env_password() {
    if std::env::var("FLORA_AUTH_SESSIONS_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_AUTH_SESSIONS_SMOKE=1");
        return;
    }
    let Ok(password) = std::env::var("FLORA_AUTH_SMOKE_PASSWORD") else {
        eprintln!("skip: set FLORA_AUTH_SMOKE_PASSWORD for success login smoke");
        return;
    };
    let user = smoke_user_uuid();
    let cfg = load_config();
    let pool = connect_pool(&cfg).await;
    let email: String = sqlx::query_scalar(
        "SELECT email FROM flora_core.user_accounts WHERE user_uuid = $1",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .expect("email");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("client");
    let res = client
        .post(gateway_login_url())
        .json(&serde_json::json!({ "email": email, "password": password }))
        .send()
        .await
        .expect("POST login");
    let status = res.status();
    let body: serde_json::Value = res.json().await.expect("json");
    assert_eq!(status, reqwest::StatusCode::OK, "body {body}");
    if body["requiresTwoFactor"] == true {
        eprintln!("ok: 2FA challenge (set code not required for this smoke)");
        return;
    }
    assert!(body["accessToken"].as_str().is_some_and(|s| !s.is_empty()));
    assert!(body["refreshToken"].as_str().is_some_and(|s| !s.is_empty()));
    assert_eq!(body["tokenType"], "Bearer");
}

#[tokio::test]
async fn register_begin_bad_email() {
    if std::env::var("FLORA_AUTH_SESSIONS_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_AUTH_SESSIONS_SMOKE=1");
        return;
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("client");
    let res = client
        .post(gateway_register_url())
        .json(&serde_json::json!({ "email": "not-an-email", "password": "x" }))
        .send()
        .await
        .expect("POST register");
    let status = res.status();
    let body: serde_json::Value = res.json().await.expect("json");
    assert_eq!(status, reqwest::StatusCode::BAD_REQUEST, "body {body}");
    assert_eq!(body["error"], "Укажите корректный email.");
}

#[tokio::test]
async fn register_verify_cancel_roundtrip_dev_code() {
    if std::env::var("FLORA_AUTH_SESSIONS_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_AUTH_SESSIONS_SMOKE=1");
        return;
    }
    let email = format!(
        "smoke-reg-{}@flora.local",
        Uuid::now_v7().as_simple()
    );
    let password = "SmokeReg-Pass-1!";
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .expect("client");

    let begin = client
        .post(gateway_register_url())
        .json(&serde_json::json!({ "email": email, "password": password }))
        .send()
        .await
        .expect("POST register");
    let begin_status = begin.status();
    let begin_body: serde_json::Value = begin.json().await.expect("json");
    assert_eq!(
        begin_status,
        reqwest::StatusCode::OK,
        "register begin body {begin_body}"
    );
    let token = begin_body["verificationToken"]
        .as_str()
        .expect("verificationToken")
        .to_string();
    let Some(code) = begin_body["devVerificationCode"].as_str().map(str::to_string) else {
        // cancel draft so we don't leave pending; then skip (SMTP-only env)
        let _ = client
            .post(gateway_cancel_registration_url())
            .json(&serde_json::json!({ "verificationToken": token }))
            .send()
            .await;
        eprintln!("skip: no devVerificationCode (SMTP production mode?)");
        return;
    };

    let verify = client
        .post(gateway_verify_registration_url())
        .json(&serde_json::json!({
            "verificationToken": token,
            "code": code
        }))
        .send()
        .await
        .expect("POST verify");
    let verify_status = verify.status();
    let verify_body: serde_json::Value = verify.json().await.expect("json");
    assert_eq!(
        verify_status,
        reqwest::StatusCode::OK,
        "verify body {verify_body}"
    );
    assert!(
        verify_body["accessToken"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
    );
    assert!(
        verify_body["refreshToken"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
    );
    assert_eq!(verify_body["tokenType"], "Bearer");
    assert_eq!(verify_body["requiresProfileCompletion"], true);

    // cleanup account so smoke can re-run
    let cfg = load_config();
    let pool = connect_pool(&cfg).await;
    let user_uuid: Uuid = sqlx::query_scalar(
        "SELECT user_uuid FROM flora_core.user_accounts WHERE email = $1",
    )
    .bind(&email)
    .fetch_one(&pool)
    .await
    .expect("created user");
    let _ = sqlx::query("DELETE FROM flora_core.user_sessions WHERE user_uuid = $1")
        .bind(user_uuid)
        .execute(&pool)
        .await;
    let _ = sqlx::query("DELETE FROM flora_core.user_security_logs WHERE user_uuid = $1")
        .bind(user_uuid)
        .execute(&pool)
        .await;
    let _ = sqlx::query("DELETE FROM flora_core.user_profiles WHERE user_uuid = $1")
        .bind(user_uuid)
        .execute(&pool)
        .await;
    let _ = sqlx::query("DELETE FROM flora_core.user_accounts WHERE user_uuid = $1")
        .bind(user_uuid)
        .execute(&pool)
        .await;
}

#[tokio::test]
async fn cancel_registration_invalid_token_ok() {
    if std::env::var("FLORA_AUTH_SESSIONS_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_AUTH_SESSIONS_SMOKE=1");
        return;
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("client");
    let res = client
        .post(gateway_cancel_registration_url())
        .json(&serde_json::json!({ "verificationToken": "not-a-uuid" }))
        .send()
        .await
        .expect("POST cancel");
    assert_eq!(res.status(), reqwest::StatusCode::OK);
}
