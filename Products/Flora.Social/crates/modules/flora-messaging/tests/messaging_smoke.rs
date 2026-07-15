//! Smoke Messaging unread-count + conversations + messages (flora-api + Messaging:ServeNative).
//!
//! ```powershell
//! $env:FLORA_MESSAGING_SMOKE=1
//! cargo test -p flora-messaging --test messaging_smoke -- --nocapture --test-threads=1
//! ```

use std::path::PathBuf;
use std::time::Duration;

use flora_auth::infrastructure::jwt::{AccessTokenClaims, JwtOptions, issue_access_token};
use flora_shared::config::FloraConfig;
use flora_shared::uuid_v5::dm_conversation_uuid;
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
async fn unread_count_and_conversations() {
    if std::env::var("FLORA_MESSAGING_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set FLORA_MESSAGING_SMOKE=1");
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
        .get(gateway("/api/messaging/unread-count"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .expect("GET unread-count — is flora-api running with Messaging:ServeNative?");
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

    let conv = client
        .get(gateway("/api/messaging/conversations?take=5"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .expect("GET conversations");
    let conv_status = conv.status();
    let conv_body: serde_json::Value = conv.json().await.expect("json");
    assert_eq!(conv_status, reqwest::StatusCode::OK, "{conv_body}");
    assert!(conv_body.get("items").and_then(|v| v.as_array()).is_some());
    assert!(conv_body.get("hasMore").and_then(|v| v.as_bool()).is_some());
    assert!(conv_body.get("nextCursor").is_some());

    // GET messages: existing conversation or empty DM via otherUserUuid.
    let (conv_uuid, other_uuid) = if let Some(items) =
        conv_body.get("items").and_then(|v| v.as_array())
        && let Some(first) = items.first()
    {
        let cu = first
            .get("conversationUuid")
            .and_then(|v| v.as_str())
            .and_then(|s| Uuid::parse_str(s).ok())
            .expect("conversationUuid");
        let ou = first
            .get("otherUserUuid")
            .and_then(|v| v.as_str())
            .and_then(|s| Uuid::parse_str(s).ok())
            .expect("otherUserUuid");
        (cu, ou)
    } else {
        let other = Uuid::parse_str("00000000-0000-4000-8000-000000000099").unwrap();
        (dm_conversation_uuid(&user, &other), other)
    };

    let msgs = client
        .get(gateway(&format!(
            "/api/messaging/conversations/{conv_uuid}/messages?take=10&otherUserUuid={other_uuid}"
        )))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .expect("GET messages");
    let msgs_status = msgs.status();
    let msgs_body: serde_json::Value = msgs.json().await.expect("json");
    assert_eq!(msgs_status, reqwest::StatusCode::OK, "{msgs_body}");
    assert!(msgs_body.get("items").and_then(|v| v.as_array()).is_some());
    assert!(msgs_body.get("hasMore").and_then(|v| v.as_bool()).is_some());

    let read = client
        .post(gateway(&format!(
            "/api/messaging/conversations/{conv_uuid}/read?otherUserUuid={other_uuid}"
        )))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .expect("POST read");
    assert_eq!(read.status(), reqwest::StatusCode::NO_CONTENT, "mark read");

    // Unknown conversation → 404.
    let bogus = Uuid::now_v7();
    let not_found = client
        .get(gateway(&format!(
            "/api/messaging/conversations/{bogus}/messages"
        )))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .expect("GET messages 404");
    assert_eq!(not_found.status(), reqwest::StatusCode::NOT_FOUND);

    // POST message without wire → 400.
    let bad_post = client
        .post(gateway(&format!(
            "/api/messaging/conversations/{conv_uuid}/messages"
        )))
        .header("Authorization", format!("Bearer {token}"))
        .json(&serde_json::json!({
            "encryptedForReceiver": "",
            "encryptedForSender": ""
        }))
        .send()
        .await
        .expect("POST message bad");
    assert_eq!(bad_post.status(), reqwest::StatusCode::BAD_REQUEST);
}
