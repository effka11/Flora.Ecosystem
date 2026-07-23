use std::collections::BTreeSet;

use base64::Engine as _;
use chrono::{DateTime, Duration, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{
    canonical_json, from_base64_url_like_dotnet, guid_field, parse_json_like_dotnet, string_field,
};

pub const NOTIFICATION_PREVIEW_WIRE_PREFIX: &str = "fscpnp1:";
pub const NOTIFICATION_PREVIEW_MAX_WIRE_BYTES: usize = 2_700;
const NOTIFICATION_PREVIEW_MAX_CIPHER_BYTES: usize = 1_024;
const SIGNATURE_DOMAIN: &str = "flora.notifications.message-preview-signature.v1";
const MAX_TTL_HOURS: i64 = 24;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationPreviewSummary {
    pub preview_id: Uuid,
    pub wire_message_uuid: Uuid,
    pub conversation_uuid: Uuid,
    pub sender_user_uuid: Uuid,
    pub recipient_user_uuid: Uuid,
    pub recipient_installation_uuid: Uuid,
    pub preview_key_id: Uuid,
    pub sender_signing_public_key_base64_url: String,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

impl NotificationPreviewSummary {
    pub fn is_fresh_at(&self, now: DateTime<Utc>) -> bool {
        self.issued_at <= now + Duration::minutes(5) && self.expires_at > now
    }
}

pub fn try_validate_notification_preview(
    preview_wire: &str,
    message_wire: &str,
    expected_recipient: Uuid,
) -> Result<NotificationPreviewSummary, String> {
    let preview_wire = preview_wire.trim();
    if preview_wire.len() > NOTIFICATION_PREVIEW_MAX_WIRE_BYTES {
        return Err("FSCP notification preview: wire слишком длинный.".into());
    }
    let Some(inner) = preview_wire.strip_prefix(NOTIFICATION_PREVIEW_WIRE_PREFIX) else {
        return Err("FSCP notification preview: неверный префикс.".into());
    };
    let json = from_base64_url_like_dotnet(inner, NOTIFICATION_PREVIEW_MAX_WIRE_BYTES)?;
    let mut root = parse_json_like_dotnet(&json)?;
    let Some(object) = root.as_object() else {
        return Err("FSCP notification preview: корень должен быть объектом.".into());
    };
    let expected_keys: BTreeSet<&str> = [
        "version",
        "previewId",
        "wireMessageUuid",
        "wireSha256Base64Url",
        "conversationUuid",
        "senderUserUuid",
        "recipientUserUuid",
        "recipientInstallationUuid",
        "previewKeyId",
        "issuedAt",
        "expiresAt",
        "ephemeralPublicKeyBase64Url",
        "saltBase64Url",
        "aead",
        "ciphertextBase64Url",
        "senderSigningPublicKeyBase64Url",
        "senderSignatureBase64Url",
    ]
    .into_iter()
    .collect();
    let actual_keys: BTreeSet<&str> = object.keys().map(String::as_str).collect();
    if expected_keys != actual_keys || root.get("version").and_then(Value::as_i64) != Some(1) {
        return Err("FSCP notification preview: неподдерживаемая форма envelope.".into());
    }

    let preview_id = required_uuid(&root, "previewId")?;
    let wire_message_uuid = required_uuid(&root, "wireMessageUuid")?;
    let conversation_uuid = required_uuid(&root, "conversationUuid")?;
    let sender_user_uuid = required_uuid(&root, "senderUserUuid")?;
    let recipient_user_uuid = required_uuid(&root, "recipientUserUuid")?;
    if recipient_user_uuid != expected_recipient {
        return Err("FSCP notification preview: recipientUserUuid не совпадает.".into());
    }
    let recipient_installation_uuid = required_uuid(&root, "recipientInstallationUuid")?;
    let preview_key_id = required_uuid(&root, "previewKeyId")?;

    let message_root = decode_message_wire(message_wire)?;
    if required_uuid(&message_root, "messageUuid")? != wire_message_uuid
        || required_uuid(&message_root, "conversationUuid")? != conversation_uuid
        || required_uuid(&message_root, "senderUserUuid")? != sender_user_uuid
    {
        return Err("FSCP notification preview: binding не совпадает с message wire.".into());
    }
    let expected_digest = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(message_wire.as_bytes()));
    if string_field(&root, "wireSha256Base64Url") != Some(expected_digest.as_str()) {
        return Err("FSCP notification preview: digest message wire не совпадает.".into());
    }

    let issued_at = parse_time(&root, "issuedAt")?;
    let expires_at = parse_time(&root, "expiresAt")?;
    if expires_at <= issued_at || expires_at - issued_at > Duration::hours(MAX_TTL_HOURS) {
        return Err("FSCP notification preview: неверный TTL.".into());
    }

    decode_exact(&root, "ephemeralPublicKeyBase64Url", 32, 64)?;
    decode_exact(&root, "saltBase64Url", 32, 64)?;
    let aead = root
        .get("aead")
        .and_then(Value::as_object)
        .ok_or_else(|| String::from("FSCP notification preview: отсутствует aead."))?;
    if aead.len() != 2 || aead.get("name").and_then(Value::as_str) != Some("xchacha20-poly1305") {
        return Err("FSCP notification preview: неподдерживаемый aead.".into());
    }
    let nonce = aead
        .get("nonceBase64Url")
        .and_then(Value::as_str)
        .ok_or_else(|| String::from("FSCP notification preview: отсутствует nonce."))?;
    if from_base64_url_like_dotnet(nonce, 32)?.len() != 24 {
        return Err("FSCP notification preview: неверный nonce.".into());
    }
    let ciphertext = string_field(&root, "ciphertextBase64Url")
        .ok_or_else(|| String::from("FSCP notification preview: отсутствует ciphertext."))?;
    let ciphertext =
        from_base64_url_like_dotnet(ciphertext, NOTIFICATION_PREVIEW_MAX_CIPHER_BYTES)?;
    if ciphertext.len() < 16 {
        return Err("FSCP notification preview: ciphertext слишком короткий.".into());
    }

    let sender_key = string_field(&root, "senderSigningPublicKeyBase64Url")
        .ok_or_else(|| String::from("FSCP notification preview: отсутствует sender signing key."))?
        .to_string();
    let message_sender_key = string_field(&message_root, "senderSigningPublicKeyBase64Url")
        .ok_or_else(|| String::from("FSCP message wire: отсутствует sender signing key."))?;
    if sender_key != message_sender_key {
        return Err(
            "FSCP notification preview: sender signing key не совпадает с message wire.".into(),
        );
    }
    let public_key: [u8; 32] = from_base64_url_like_dotnet(&sender_key, 64)?
        .try_into()
        .map_err(|_| String::from("FSCP notification preview: неверный sender signing key."))?;
    let signature_text = string_field(&root, "senderSignatureBase64Url")
        .ok_or_else(|| String::from("FSCP notification preview: отсутствует подпись."))?;
    let signature: [u8; 64] = from_base64_url_like_dotnet(signature_text, 96)?
        .try_into()
        .map_err(|_| String::from("FSCP notification preview: неверная подпись."))?;
    root.as_object_mut()
        .expect("shape checked")
        .remove("senderSignatureBase64Url");
    let payload = format!("{SIGNATURE_DOMAIN} | {}", canonical_json(&root));
    let verifying_key = VerifyingKey::from_bytes(&public_key)
        .map_err(|_| String::from("FSCP notification preview: неверный sender signing key."))?;
    verifying_key
        .verify(payload.as_bytes(), &Signature::from_bytes(&signature))
        .map_err(|_| String::from("FSCP notification preview: подпись не прошла проверку."))?;

    Ok(NotificationPreviewSummary {
        preview_id,
        wire_message_uuid,
        conversation_uuid,
        sender_user_uuid,
        recipient_user_uuid,
        recipient_installation_uuid,
        preview_key_id,
        sender_signing_public_key_base64_url: sender_key,
        issued_at,
        expires_at,
    })
}

fn decode_message_wire(wire: &str) -> Result<Value, String> {
    let inner = wire
        .trim()
        .strip_prefix(fscp_contracts::WIRE_PREFIX)
        .ok_or_else(|| String::from("FSCP message wire: неверный префикс."))?;
    let bytes = from_base64_url_like_dotnet(inner, 120_000)?;
    parse_json_like_dotnet(&bytes)
}

fn required_uuid(value: &Value, field: &str) -> Result<Uuid, String> {
    guid_field(value, field).ok_or_else(|| format!("FSCP notification preview: неверный {field}."))
}

fn decode_exact(value: &Value, field: &str, expected: usize, max: usize) -> Result<(), String> {
    let encoded = string_field(value, field)
        .ok_or_else(|| format!("FSCP notification preview: отсутствует {field}."))?;
    if from_base64_url_like_dotnet(encoded, max)?.len() != expected {
        return Err(format!("FSCP notification preview: неверный {field}."));
    }
    Ok(())
}

fn parse_time(value: &Value, field: &str) -> Result<DateTime<Utc>, String> {
    let raw = string_field(value, field)
        .ok_or_else(|| format!("FSCP notification preview: отсутствует {field}."))?;
    DateTime::parse_from_rfc3339(raw)
        .map(|time| time.with_timezone(&Utc))
        .map_err(|_| format!("FSCP notification preview: неверный {field}."))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vector() -> Value {
        serde_json::from_str(include_str!(
            "../../../../../Documents/test-vectors/fscp-notification-preview-v1.json"
        ))
        .expect("generated preview vector")
    }

    #[test]
    fn generated_ts_vector_validates_in_rust() {
        let vector = vector();
        let recipient = Uuid::parse_str(
            vector["recipientUserUuid"]
                .as_str()
                .expect("recipientUserUuid"),
        )
        .unwrap();
        let summary = try_validate_notification_preview(
            vector["previewWire"].as_str().expect("previewWire"),
            vector["messageWire"].as_str().expect("messageWire"),
            recipient,
        )
        .expect("TS-generated envelope must validate");
        assert_eq!(summary.recipient_user_uuid, recipient);
        assert_eq!(
            summary.preview_key_id,
            Uuid::parse_str(vector["previewKeyId"].as_str().unwrap()).unwrap()
        );
    }

    #[test]
    fn substituted_message_wire_is_rejected() {
        let vector = vector();
        let recipient = Uuid::parse_str(vector["recipientUserUuid"].as_str().unwrap()).unwrap();
        let mut message_wire = vector["messageWire"].as_str().unwrap().to_string();
        message_wire.push(' ');
        assert!(
            try_validate_notification_preview(
                vector["previewWire"].as_str().unwrap(),
                &message_wire,
                recipient,
            )
            .is_err()
        );
    }
}
