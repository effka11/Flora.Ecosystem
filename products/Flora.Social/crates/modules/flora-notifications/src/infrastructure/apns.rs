use std::sync::Arc;

use chrono::Utc;
use flora_shared::config::FloraConfig;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use serde::Serialize;
use serde_json::json;
use uuid::Uuid;

use crate::infrastructure::PushTokenRepo;

#[derive(Serialize)]
struct ApnsClaims<'a> {
    iss: &'a str,
    iat: i64,
}

struct ApnsCredentials {
    team_id: String,
    key_id: String,
    topic: String,
    private_key: EncodingKey,
    sandbox: bool,
}

pub struct ApnsPushSender {
    http: reqwest::Client,
    credentials: Option<ApnsCredentials>,
    token_repo: Arc<PushTokenRepo>,
}

impl ApnsPushSender {
    pub fn from_config(cfg: &FloraConfig, token_repo: Arc<PushTokenRepo>) -> Self {
        let credentials = load_credentials(cfg);
        if credentials.is_some() {
            tracing::info!("Direct APNs push enabled.");
        } else {
            tracing::info!(
                "Direct APNs push disabled. Configure Push:Apns:TeamId, KeyId, Topic and PrivateKey."
            );
        }
        Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
            credentials,
            token_repo,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn send_message_push(
        &self,
        recipient_user_uuid: Uuid,
        token: &str,
        title: &str,
        conversation_uuid: Uuid,
        sender_user_uuid: Uuid,
        persisted_message_uuid: Uuid,
        wire_message_uuid: Uuid,
        encrypted_preview: Option<&str>,
    ) {
        let Some(credentials) = self.credentials.as_ref() else {
            return;
        };
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some(credentials.key_id.clone());
        let jwt = match encode(
            &header,
            &ApnsClaims {
                iss: &credentials.team_id,
                iat: Utc::now().timestamp(),
            },
            &credentials.private_key,
        ) {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!(%error, "APNs JWT creation failed");
                return;
            }
        };
        let payload = apns_message_payload(
            title,
            conversation_uuid,
            sender_user_uuid,
            persisted_message_uuid,
            wire_message_uuid,
            encrypted_preview,
        );
        let payload_bytes = match bounded_apns_payload(payload) {
            Some(value) => value,
            None => return,
        };
        let host = if credentials.sandbox {
            "https://api.sandbox.push.apple.com"
        } else {
            "https://api.push.apple.com"
        };
        for attempt in 0..2 {
            let response = self
                .http
                .post(format!("{host}/3/device/{}", token.trim()))
                .header("authorization", format!("bearer {jwt}"))
                .header("apns-topic", &credentials.topic)
                .header("apns-push-type", "alert")
                .header("apns-priority", "10")
                .header(
                    "apns-expiration",
                    (Utc::now().timestamp() + 24 * 60 * 60).to_string(),
                )
                .body(payload_bytes.clone())
                .send()
                .await;
            match response {
                Ok(response) if response.status().is_success() => break,
                Ok(response)
                    if attempt == 0
                        && (response.status().is_server_error()
                            || response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS) =>
                {
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                }
                Ok(response) => {
                    let status = response.status();
                    let reason = response.text().await.unwrap_or_default();
                    tracing::warn!(%status, reason = %reason, "APNs push rejected");
                    if status == reqwest::StatusCode::GONE || reason.contains("BadDeviceToken") {
                        let _ = self.token_repo.unregister(recipient_user_uuid, token).await;
                    }
                    break;
                }
                Err(error) if attempt == 0 && error.is_timeout() => {
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                }
                Err(error) => {
                    tracing::warn!(%error, "APNs push failed");
                    break;
                }
            }
        }
    }
}

fn apns_message_payload(
    title: &str,
    conversation_uuid: Uuid,
    sender_user_uuid: Uuid,
    persisted_message_uuid: Uuid,
    wire_message_uuid: Uuid,
    encrypted_preview: Option<&str>,
) -> serde_json::Value {
    let mut payload = json!({
        "aps": {
            "alert": { "title": title, "body": "Новое сообщение" },
            "mutable-content": 1,
            "thread-id": conversation_uuid.to_string(),
            "sound": "default"
        },
        "type": "secure_message_v1",
        "conversationUuid": conversation_uuid.to_string(),
        "senderUserUuid": sender_user_uuid.to_string(),
        "persistedMessageUuid": persisted_message_uuid.to_string(),
        "wireMessageUuid": wire_message_uuid.to_string(),
        "tag": conversation_uuid.to_string()
    });
    if let Some(envelope) = encrypted_preview {
        payload["encryptedPreview"] = json!(envelope);
    }
    payload
}

fn bounded_apns_payload(mut payload: serde_json::Value) -> Option<Vec<u8>> {
    let bytes = serde_json::to_vec(&payload).ok()?;
    if bytes.len() <= 4_096 {
        return Some(bytes);
    }
    payload.as_object_mut()?.remove("encryptedPreview");
    let fallback = serde_json::to_vec(&payload).ok()?;
    (fallback.len() <= 4_096).then_some(fallback)
}

fn load_credentials(cfg: &FloraConfig) -> Option<ApnsCredentials> {
    let team_id = cfg.get_non_empty("Push:Apns:TeamId")?.to_string();
    let key_id = cfg.get_non_empty("Push:Apns:KeyId")?.to_string();
    let topic = cfg
        .get_non_empty("Push:Apns:Topic")
        .unwrap_or("social.flora.mobile")
        .to_string();
    let raw_key = cfg
        .get_non_empty("Push:Apns:PrivateKey")?
        .replace("\\n", "\n");
    let private_key = EncodingKey::from_ec_pem(raw_key.as_bytes()).ok()?;
    Some(ApnsCredentials {
        team_id,
        key_id,
        topic,
        private_key,
        sandbox: cfg.get_bool("Push:Apns:Sandbox") == Some(true),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apns_secure_payload_uses_generic_alert_and_opaque_envelope() {
        let payload = apns_message_payload(
            "Отправитель",
            Uuid::now_v7(),
            Uuid::now_v7(),
            Uuid::now_v7(),
            Uuid::now_v7(),
            Some("fscpnp1:opaque"),
        );
        assert_eq!(payload["aps"]["alert"]["body"], "Новое сообщение");
        assert_eq!(payload["aps"]["mutable-content"], 1);
        assert_eq!(payload["encryptedPreview"], "fscpnp1:opaque");
        assert!(payload.get("messagePreview").is_none());
    }

    #[test]
    fn apns_payload_keeps_exact_boundary_and_drops_oversize_preview() {
        let ids = [
            Uuid::now_v7(),
            Uuid::now_v7(),
            Uuid::now_v7(),
            Uuid::now_v7(),
        ];
        let empty = apns_message_payload("Flora", ids[0], ids[1], ids[2], ids[3], Some(""));
        let overhead = serde_json::to_vec(&empty).unwrap().len();
        let exact_envelope = "x".repeat(4_096 - overhead);
        let exact = bounded_apns_payload(apns_message_payload(
            "Flora",
            ids[0],
            ids[1],
            ids[2],
            ids[3],
            Some(&exact_envelope),
        ))
        .unwrap();
        assert_eq!(exact.len(), 4_096);
        assert!(
            serde_json::from_slice::<serde_json::Value>(&exact).unwrap()["encryptedPreview"]
                .is_string()
        );

        let oversize_envelope = format!("{exact_envelope}x");
        let fallback = bounded_apns_payload(apns_message_payload(
            "Flora",
            ids[0],
            ids[1],
            ids[2],
            ids[3],
            Some(&oversize_envelope),
        ))
        .unwrap();
        assert!(fallback.len() < 4_096);
        assert!(
            serde_json::from_slice::<serde_json::Value>(&fallback).unwrap()["encryptedPreview"]
                .is_null()
        );
    }
}
