//! Smoke Notifications list + unread-count (flora-api + Notifications:ServeNative).
//!
//! ```powershell
//! $env:FLORA_NOTIFICATIONS_SMOKE=1
//! cargo test -p flora-notifications --test notifications_smoke -- --nocapture --test-threads=1
//! ```

use std::path::PathBuf;
use std::time::Duration;

use flora_auth::infrastructure::jwt::{AccessTokenClaims, JwtOptions, issue_access_token};
use flora_shared::config::FloraConfig;
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
async fn list_and_unread_count() {
    if std::env::var("FLORA_NOTIFICATIONS_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_NOTIFICATIONS_SMOKE=1");
        return;
    }
    let secret = load_dev_jwt_secret().expect("jwt secret");
    let user = smoke_user_uuid();
    let token = mint_bearer(secret, user);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("client");

    let unread = client
        .get(gateway("/api/auth/notifications/unread-count"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .expect("GET unread-count — is flora-api running with Notifications:ServeNative?");
    let unread_status = unread.status();
    let unread_body: serde_json::Value = unread.json().await.expect("json");
    assert_eq!(unread_status, reqwest::StatusCode::OK, "{unread_body}");
    assert!(
        unread_body
            .get("unreadCount")
            .and_then(|v| v.as_i64())
            .is_some(),
        "{unread_body}"
    );

    let list = client
        .get(gateway("/api/auth/notifications?take=5"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .expect("GET notifications list");
    let list_status = list.status();
    let list_body: serde_json::Value = list.json().await.expect("json");
    assert_eq!(list_status, reqwest::StatusCode::OK, "{list_body}");
    assert!(list_body.is_array(), "{list_body}");

    let missing = Uuid::now_v7();
    let patch = client
        .patch(gateway(&format!("/api/auth/notifications/{missing}/read")))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .expect("PATCH mark-read missing");
    let patch_status = patch.status();
    let patch_body: serde_json::Value = patch.json().await.expect("json");
    assert_eq!(patch_status, reqwest::StatusCode::NOT_FOUND, "{patch_body}");
    assert_eq!(
        patch_body.get("error").and_then(|v| v.as_str()),
        Some("Уведомление не найдено.")
    );

    let mark_all = client
        .post(gateway("/api/auth/notifications/read"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .expect("POST mark-all-read");
    let mark_all_status = mark_all.status();
    let mark_all_body: serde_json::Value = mark_all.json().await.expect("json");
    assert_eq!(mark_all_status, reqwest::StatusCode::OK, "{mark_all_body}");
    assert!(
        mark_all_body
            .get("marked")
            .and_then(|v| v.as_i64())
            .is_some(),
        "{mark_all_body}"
    );

    let bad_delete = client
        .delete(gateway("/api/auth/notifications"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .body(r#"{"notificationUuids":[]}"#)
        .send()
        .await
        .expect("DELETE notifications empty body");
    let bad_delete_status = bad_delete.status();
    let bad_delete_body: serde_json::Value = bad_delete.json().await.expect("json");
    assert_eq!(
        bad_delete_status,
        reqwest::StatusCode::BAD_REQUEST,
        "{bad_delete_body}"
    );
    assert_eq!(
        bad_delete_body.get("error").and_then(|v| v.as_str()),
        Some("Укажите уведомления для удаления.")
    );
}
