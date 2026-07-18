//! FCM HTTP v1 sender — паритет `FcmPushSender.cs` (Firebase Admin → тот же wire).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use flora_shared::config::FloraConfig;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use super::PushTokenRepo;

const FCM_SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_REFRESH_SKEW: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Deserialize)]
struct ServiceAccount {
    project_id: String,
    client_email: String,
    private_key: String,
    #[serde(default = "default_token_uri")]
    token_uri: String,
}

fn default_token_uri() -> String {
    "https://oauth2.googleapis.com/token".into()
}

#[derive(Debug, Serialize)]
struct GoogleJwtClaims<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    iat: i64,
    exp: i64,
}

struct CachedAccessToken {
    token: String,
    expires_at: Instant,
}

/// `IMessagePushDispatcher` — message + inbox notification FCM payloads.
pub struct FcmPushSender {
    http: reqwest::Client,
    credentials: Option<ServiceAccount>,
    token_cache: Mutex<Option<CachedAccessToken>>,
    push_tokens: std::sync::Arc<PushTokenRepo>,
}

impl FcmPushSender {
    pub fn from_config(cfg: &FloraConfig, push_tokens: std::sync::Arc<PushTokenRepo>) -> Self {
        let credentials = load_credentials(cfg);
        if credentials.is_some() {
            tracing::info!("FCM push enabled for message notifications.");
        } else {
            tracing::info!(
                "FCM push disabled. Set Push:Firebase:CredentialsJson or CredentialsPath (see Flora.API/appsettings.Local.example.json)."
            );
        }
        Self {
            http: reqwest::Client::new(),
            credentials,
            token_cache: Mutex::new(None),
            push_tokens,
        }
    }

    pub async fn send_message_push(
        &self,
        recipient_user_uuid: Uuid,
        device_tokens: &[String],
        sender_display_name: &str,
        body: &str,
        conversation_uuid: Uuid,
        sender_user_uuid: Uuid,
    ) {
        let title = {
            let t = sender_display_name.trim();
            if t.is_empty() { "Flora" } else { t }
        };
        let mut notification_body = {
            let b = body.trim();
            if b.is_empty() {
                "Новое сообщение".to_string()
            } else {
                b.to_string()
            }
        };
        if notification_body.chars().count() > 120 {
            notification_body = truncate_chars(&notification_body, 117) + "...";
        }

        let mut data = HashMap::new();
        data.insert("type".into(), "message".into());
        data.insert("conversationUuid".into(), conversation_uuid.to_string());
        data.insert("senderUserUuid".into(), sender_user_uuid.to_string());
        data.insert("messagePreview".into(), notification_body.clone());
        data.insert("tag".into(), conversation_uuid.to_string());

        self.send(
            recipient_user_uuid,
            device_tokens,
            title,
            &notification_body,
            &data,
            "messages",
            true,
            Some(title),
            Some(notification_body.as_str()),
        )
        .await;
    }

    /// Data-only HIGH FCM for sideload `app_update` — no `notification` key so the
    /// payload is delivered to the app process even when killed (Android).
    pub async fn send_app_update_push(
        &self,
        recipient_user_uuid: Uuid,
        device_tokens: &[String],
        notification_uuid: Uuid,
        text: &str,
        update: Option<&flora_notifications_contracts::AppUpdatePayload>,
    ) {
        let mut body = text.trim().to_string();
        if body.chars().count() > 120 {
            body = truncate_chars(&body, 117) + "...";
        }

        let mut data = HashMap::new();
        data.insert("type".into(), "app_update".into());
        data.insert("notificationUuid".into(), notification_uuid.to_string());
        data.insert("inboxType".into(), "app_update".into());
        data.insert("category".into(), "developer".into());
        data.insert("text".into(), body);
        if let Some(u) = update {
            data.insert("version".into(), u.version.clone());
            data.insert("versionCode".into(), u.version_code.to_string());
            data.insert("apkUrl".into(), u.apk_url.clone());
            data.insert("sha256".into(), u.sha256.clone());
            if let Some(size) = u.size_bytes {
                data.insert("sizeBytes".into(), size.to_string());
            }
        }

        self.send_data_only(recipient_user_uuid, device_tokens, &data, true)
            .await;
    }

    /// Паритет `FcmPushSender.SendInboxNotificationPushAsync`.
    #[allow(clippy::too_many_arguments)] // wire parity with C# SendInboxNotificationPushAsync
    pub async fn send_inbox_notification_push(
        &self,
        recipient_user_uuid: Uuid,
        device_tokens: &[String],
        notification_uuid: Uuid,
        inbox_type: &str,
        category: &str,
        text: &str,
        actor_display_name: Option<&str>,
        post_uuid: Option<Uuid>,
        comment_uuid: Option<Uuid>,
    ) {
        let title = actor_display_name
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Flora");
        let mut body = text.trim().to_string();
        if body.chars().count() > 120 {
            body = truncate_chars(&body, 117) + "...";
        }

        let mut data = HashMap::new();
        data.insert("type".into(), "notification".into());
        data.insert("notificationUuid".into(), notification_uuid.to_string());
        data.insert("inboxType".into(), inbox_type.to_string());
        data.insert("category".into(), category.to_string());
        if let Some(post) = post_uuid {
            data.insert("postUuid".into(), post.to_string());
        }
        if let Some(comment) = comment_uuid {
            data.insert("commentUuid".into(), comment.to_string());
        }

        self.send(
            recipient_user_uuid,
            device_tokens,
            title,
            &body,
            &data,
            "notifications",
            false,
            None,
            None,
        )
        .await;
    }

    #[allow(clippy::too_many_arguments)]
    async fn send(
        &self,
        recipient_user_uuid: Uuid,
        device_tokens: &[String],
        title: &str,
        body: &str,
        data: &HashMap<String, String>,
        android_channel_id: &str,
        high_priority: bool,
        android_title: Option<&str>,
        android_body: Option<&str>,
    ) {
        let mut android_notification = json!({
            "channel_id": android_channel_id,
            "title": android_title.unwrap_or(title),
            "body": android_body.unwrap_or(body),
        });
        if let Some(tag) = data.get("tag") {
            android_notification["tag"] = json!(tag);
        }

        let priority = if high_priority { "HIGH" } else { "NORMAL" };
        let payload_for = |token: &str| {
            json!({
                "message": {
                    "token": token,
                    "notification": {
                        "title": title,
                        "body": body,
                    },
                    "data": data,
                    "android": {
                        "priority": priority,
                        "notification": android_notification.clone(),
                    },
                }
            })
        };

        self.dispatch_to_tokens(recipient_user_uuid, device_tokens, payload_for)
            .await;
    }

    /// Data-only FCM (no `notification` / `android.notification`) for background wake.
    async fn send_data_only(
        &self,
        recipient_user_uuid: Uuid,
        device_tokens: &[String],
        data: &HashMap<String, String>,
        high_priority: bool,
    ) {
        let payload_for = |token: &str| {
            json!({
                "message": {
                    "token": token,
                    "data": data,
                    "android": {
                        "priority": if high_priority { "HIGH" } else { "NORMAL" },
                    },
                }
            })
        };
        self.dispatch_to_tokens(recipient_user_uuid, device_tokens, payload_for)
            .await;
    }

    async fn dispatch_to_tokens<F>(&self, recipient_user_uuid: Uuid, device_tokens: &[String], payload_for: F)
    where
        F: Fn(&str) -> serde_json::Value,
    {
        let Some(sa) = self.credentials.as_ref() else {
            return;
        };
        if device_tokens.is_empty() {
            return;
        }

        let mut seen = std::collections::HashSet::new();
        for token in device_tokens {
            let token = token.trim();
            if token.is_empty() || !seen.insert(token.to_string()) {
                continue;
            }

            let payload = payload_for(token);
            match self.post_fcm(sa, &payload).await {
                Ok(()) => {}
                Err(FcmSendError::InvalidToken) => {
                    let prefix = if token.len() > 8 { &token[..8] } else { token };
                    tracing::info!("Removing invalid FCM token prefix {prefix}");
                    if let Err(e) = self
                        .push_tokens
                        .unregister(recipient_user_uuid, token)
                        .await
                    {
                        tracing::warn!(error = %e, "failed to unregister invalid FCM token");
                    }
                }
                Err(FcmSendError::Other(msg)) => {
                    let prefix = if token.len() > 8 { &token[..8] } else { token };
                    tracing::warn!("FCM send failed for token prefix {prefix}: {msg}");
                }
            }
        }
    }

    async fn post_fcm(
        &self,
        sa: &ServiceAccount,
        payload: &serde_json::Value,
    ) -> Result<(), FcmSendError> {
        let access_token = self.access_token(sa).await.map_err(FcmSendError::Other)?;
        let url = format!(
            "https://fcm.googleapis.com/v1/projects/{}/messages:send",
            sa.project_id
        );
        let response = self
            .http
            .post(&url)
            .bearer_auth(&access_token)
            .json(payload)
            .send()
            .await
            .map_err(|e| FcmSendError::Other(e.to_string()))?;

        let status = response.status();
        if status.is_success() {
            return Ok(());
        }

        let body = response.text().await.unwrap_or_default();
        if is_invalid_token_response(status.as_u16(), &body) {
            return Err(FcmSendError::InvalidToken);
        }
        Err(FcmSendError::Other(format!("HTTP {status}: {body}")))
    }

    async fn access_token(&self, sa: &ServiceAccount) -> Result<String, String> {
        {
            let cache = self.token_cache.lock().expect("fcm token cache");
            if let Some(cached) = cache.as_ref()
                && Instant::now() + TOKEN_REFRESH_SKEW < cached.expires_at
            {
                return Ok(cached.token.clone());
            }
        }

        let now = chrono::Utc::now().timestamp();
        let claims = GoogleJwtClaims {
            iss: &sa.client_email,
            scope: FCM_SCOPE,
            aud: &sa.token_uri,
            iat: now,
            exp: now + 3600,
        };
        let key = EncodingKey::from_rsa_pem(sa.private_key.as_bytes())
            .map_err(|e| format!("FCM private key: {e}"))?;
        let assertion = encode(&Header::new(Algorithm::RS256), &claims, &key)
            .map_err(|e| format!("FCM jwt: {e}"))?;

        let form_body = format!(
            "grant_type={}&assertion={}",
            urlencoding_encode("urn:ietf:params:oauth:grant-type:jwt-bearer"),
            urlencoding_encode(&assertion)
        );
        let response = self
            .http
            .post(&sa.token_uri)
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .body(form_body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("OAuth token HTTP {status}: {body}"));
        }
        #[derive(Deserialize)]
        struct TokenResponse {
            access_token: String,
            #[serde(default = "default_expires_in")]
            expires_in: u64,
        }
        fn default_expires_in() -> u64 {
            3600
        }
        let token_response: TokenResponse = response.json().await.map_err(|e| e.to_string())?;
        let expires_at = Instant::now() + Duration::from_secs(token_response.expires_in);
        let mut cache = self.token_cache.lock().expect("fcm token cache");
        *cache = Some(CachedAccessToken {
            token: token_response.access_token.clone(),
            expires_at,
        });
        Ok(token_response.access_token)
    }
}

enum FcmSendError {
    InvalidToken,
    Other(String),
}

fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Minimal form-urlencoded for OAuth assertion (no extra crate).
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{b:02X}"));
            }
        }
    }
    out
}

fn is_invalid_token_response(status: u16, body: &str) -> bool {
    let upper = body.to_ascii_uppercase();
    if upper.contains("UNREGISTERED")
        || upper.contains("SENDER_ID_MISMATCH")
        || upper.contains("\"ERRORCODE\": \"INVALID_ARGUMENT\"")
        || upper.contains("\"ERRORCODE\":\"INVALID_ARGUMENT\"")
    {
        return true;
    }
    // Firebase Admin maps InvalidArgument + NOT_FOUND-ish registration to invalid token.
    if status == 404 && upper.contains("NOT_FOUND") {
        return true;
    }
    false
}

fn load_credentials(cfg: &FloraConfig) -> Option<ServiceAccount> {
    let json = cfg.get_non_empty("Push:Firebase:CredentialsJson");
    let path = cfg.get_non_empty("Push:Firebase:CredentialsPath");
    if json.is_none() && path.is_none() {
        return None;
    }

    let raw = if let Some(j) = json {
        j.to_string()
    } else {
        let resolved = resolve_credential_file_path(path.unwrap())?;
        match std::fs::read_to_string(&resolved) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(
                    path = %resolved.display(),
                    error = %e,
                    "FCM disabled: failed to read credentials file"
                );
                return None;
            }
        }
    };

    match serde_json::from_str::<ServiceAccount>(&raw) {
        Ok(sa) => Some(sa),
        Err(e) => {
            tracing::warn!(error = %e, "FCM disabled: failed to parse Firebase credentials JSON");
            None
        }
    }
}

fn resolve_api_content_root() -> PathBuf {
    for start in [
        std::env::current_dir().ok(),
        std::env::current_exe()
            .ok()
            .map(|p| p.parent().unwrap_or(Path::new(".")).to_path_buf()),
    ]
    .into_iter()
    .flatten()
    {
        let mut dir = start;
        loop {
            if dir.join("Flora.API.csproj").is_file() {
                return dir;
            }
            let nested = dir.join("Flora.API");
            if nested.join("Flora.API.csproj").is_file() {
                return nested;
            }
            // Rust host: Backend/ as content root when Flora.API is absent.
            if dir.join("appsettings.json").is_file()
                && (dir.join("crates").is_dir() || dir.file_name().is_some_and(|n| n == "Backend"))
            {
                return dir;
            }
            match dir.parent() {
                Some(parent) => dir = parent.to_path_buf(),
                None => break,
            }
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn resolve_credential_file_path(configured_path: &str) -> Option<PathBuf> {
    let content_root = resolve_api_content_root();
    let mut candidates = Vec::new();
    let configured = Path::new(configured_path);
    if configured.is_absolute() {
        candidates.push(configured.to_path_buf());
    } else {
        candidates.push(content_root.join(configured));
        if let Ok(full) = std::fs::canonicalize(configured) {
            candidates.push(full);
        } else {
            candidates.push(PathBuf::from(configured_path));
        }
    }

    for candidate in &candidates {
        if candidate.is_file() {
            return Some(candidate.clone());
        }
    }

    let secrets_dir = content_root.join("secrets");
    if secrets_dir.is_dir() {
        let json_files: Vec<_> = std::fs::read_dir(&secrets_dir)
            .ok()?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.extension().is_some_and(|ext| ext == "json")
                    && !p
                        .file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.to_ascii_lowercase().ends_with(".example.json"))
            })
            .collect();
        if json_files.len() == 1 {
            tracing::info!(
                "Push:Firebase:CredentialsPath not found; using {}",
                json_files[0]
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("?")
            );
            return Some(json_files[0].clone());
        }
    }

    tracing::warn!(
        path = %candidates.first().map(|p| p.display().to_string()).unwrap_or_default(),
        "FCM disabled: credentials file not found"
    );
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_matches_csharp_slice() {
        let s: String = (0..130).map(|_| 'я').collect();
        assert_eq!(truncate_chars(&s, 117).chars().count(), 117);
    }

    #[test]
    fn invalid_token_detects_unregistered() {
        let body = r#"{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}"#;
        assert!(is_invalid_token_response(404, body));
    }
}
