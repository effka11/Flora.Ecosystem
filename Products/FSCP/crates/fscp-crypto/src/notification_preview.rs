use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use hkdf::Hkdf;
use serde::Deserialize;
use serde_json::Value;
use sha2::Sha256;
use uuid::Uuid;
use x25519_dalek::x25519;

const AAD_DOMAIN: &str = "flora.notifications.message-preview.v1";
const SIGNATURE_DOMAIN: &str = "flora.notifications.message-preview-signature.v1";
const PREFIX: &str = "fscpnp1:";
const MAX_WIRE_BYTES: usize = 2_700;
const MAX_PREVIEW_CHARS: usize = 120;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationPreviewPlaintext {
    pub preview: String,
    pub kind: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationPreviewError {
    Malformed,
    Binding,
    Expired,
    Signature,
    Decrypt,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    version: u8,
    preview_id: Uuid,
    wire_message_uuid: Uuid,
    wire_sha256_base64_url: String,
    conversation_uuid: Uuid,
    sender_user_uuid: Uuid,
    recipient_user_uuid: Uuid,
    recipient_installation_uuid: Uuid,
    preview_key_id: Uuid,
    issued_at: String,
    expires_at: String,
    ephemeral_public_key_base64_url: String,
    salt_base64_url: String,
    aead: AeadWire,
    ciphertext_base64_url: String,
    sender_signing_public_key_base64_url: String,
    sender_signature_base64_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AeadWire {
    name: String,
    nonce_base64_url: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Plaintext {
    preview: String,
    kind: String,
    pad: String,
}

pub fn open_notification_preview(
    wire: &str,
    recipient_user_uuid: Uuid,
    recipient_installation_uuid: Uuid,
    preview_key_id: Uuid,
    recipient_private_key: &[u8; 32],
    now: DateTime<Utc>,
) -> Result<NotificationPreviewPlaintext, NotificationPreviewError> {
    if wire.len() > MAX_WIRE_BYTES {
        return Err(NotificationPreviewError::Malformed);
    }
    let inner = wire
        .strip_prefix(PREFIX)
        .ok_or(NotificationPreviewError::Malformed)?;
    let json = decode_b64(inner, MAX_WIRE_BYTES)?;
    let mut root: Value =
        serde_json::from_slice(&json).map_err(|_| NotificationPreviewError::Malformed)?;
    let env: Envelope =
        serde_json::from_value(root.clone()).map_err(|_| NotificationPreviewError::Malformed)?;
    if env.version != 1
        || env.aead.name != "xchacha20-poly1305"
        || env.recipient_user_uuid != recipient_user_uuid
        || env.recipient_installation_uuid != recipient_installation_uuid
        || env.preview_key_id != preview_key_id
    {
        return Err(NotificationPreviewError::Binding);
    }

    let issued_at = DateTime::parse_from_rfc3339(&env.issued_at)
        .map_err(|_| NotificationPreviewError::Malformed)?
        .with_timezone(&Utc);
    let expires_at = DateTime::parse_from_rfc3339(&env.expires_at)
        .map_err(|_| NotificationPreviewError::Malformed)?
        .with_timezone(&Utc);
    if expires_at <= issued_at
        || expires_at - issued_at > chrono::Duration::hours(24)
        || issued_at > now + chrono::Duration::minutes(5)
        || now > expires_at
    {
        return Err(NotificationPreviewError::Expired);
    }

    let public_key: [u8; 32] = decode_b64(&env.sender_signing_public_key_base64_url, 64)?
        .try_into()
        .map_err(|_| NotificationPreviewError::Malformed)?;
    let signature: [u8; 64] = decode_b64(&env.sender_signature_base64_url, 96)?
        .try_into()
        .map_err(|_| NotificationPreviewError::Malformed)?;
    root.as_object_mut()
        .ok_or(NotificationPreviewError::Malformed)?
        .remove("senderSignatureBase64Url");
    let signed = format!("{SIGNATURE_DOMAIN} | {}", fscp_core::canonical_json(&root));
    VerifyingKey::from_bytes(&public_key)
        .map_err(|_| NotificationPreviewError::Signature)?
        .verify(signed.as_bytes(), &Signature::from_bytes(&signature))
        .map_err(|_| NotificationPreviewError::Signature)?;

    let ephemeral: [u8; 32] = decode_b64(&env.ephemeral_public_key_base64_url, 64)?
        .try_into()
        .map_err(|_| NotificationPreviewError::Malformed)?;
    let salt = decode_b64(&env.salt_base64_url, 64)?;
    if salt.len() != 32 {
        return Err(NotificationPreviewError::Malformed);
    }
    let nonce = decode_b64(&env.aead.nonce_base64_url, 32)?;
    if nonce.len() != 24 {
        return Err(NotificationPreviewError::Malformed);
    }
    let ciphertext = decode_b64(&env.ciphertext_base64_url, 1_024)?;
    if ciphertext.len() < 16 {
        return Err(NotificationPreviewError::Malformed);
    }
    let mut shared_secret = x25519(*recipient_private_key, ephemeral);
    let hkdf = Hkdf::<Sha256>::new(Some(&salt), &shared_secret);
    shared_secret.fill(0);
    let aad = aad_line(&env);
    let mut key_bytes = [0_u8; 32];
    hkdf.expand(aad.as_bytes(), &mut key_bytes)
        .map_err(|_| NotificationPreviewError::Decrypt)?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key_bytes));
    let decrypted = cipher.decrypt(
        XNonce::from_slice(&nonce),
        Payload {
            msg: &ciphertext,
            aad: aad.as_bytes(),
        },
    );
    key_bytes.fill(0);
    let plaintext = decrypted.map_err(|_| NotificationPreviewError::Decrypt)?;
    if !matches!(plaintext.len(), 128 | 256 | 512 | 768) {
        return Err(NotificationPreviewError::Malformed);
    }

    let plaintext: Plaintext =
        serde_json::from_slice(&plaintext).map_err(|_| NotificationPreviewError::Malformed)?;
    let valid_kind = matches!(
        plaintext.kind.as_str(),
        "text" | "photo" | "voice" | "video" | "mixed"
    );
    if !valid_kind
        || plaintext.preview.chars().count() > MAX_PREVIEW_CHARS
        || !plaintext.pad.bytes().all(|byte| byte == b' ')
    {
        return Err(NotificationPreviewError::Malformed);
    }
    Ok(NotificationPreviewPlaintext {
        preview: plaintext.preview,
        kind: plaintext.kind,
    })
}

fn aad_line(env: &Envelope) -> String {
    [
        AAD_DOMAIN.to_string(),
        env.preview_id.to_string(),
        env.wire_message_uuid.to_string(),
        env.wire_sha256_base64_url.clone(),
        env.conversation_uuid.to_string(),
        env.sender_user_uuid.to_string(),
        env.recipient_user_uuid.to_string(),
        env.recipient_installation_uuid.to_string(),
        env.preview_key_id.to_string(),
        env.issued_at.clone(),
        env.expires_at.clone(),
    ]
    .join(" | ")
}

fn decode_b64(value: &str, max: usize) -> Result<Vec<u8>, NotificationPreviewError> {
    if value.len() > max.saturating_mul(2) {
        return Err(NotificationPreviewError::Malformed);
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| NotificationPreviewError::Malformed)
        .and_then(|bytes| {
            if bytes.len() <= max {
                Ok(bytes)
            } else {
                Err(NotificationPreviewError::Malformed)
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_generated_typescript_vector() {
        let vector: Value = serde_json::from_str(include_str!(
            "../../../../../Documents/test-vectors/fscp-notification-preview-v1.json"
        ))
        .unwrap();
        let private_key: [u8; 32] = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(vector["previewPrivateKeyBase64Url"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let opened = open_notification_preview(
            vector["previewWire"].as_str().unwrap(),
            Uuid::parse_str(vector["recipientUserUuid"].as_str().unwrap()).unwrap(),
            Uuid::parse_str(vector["recipientInstallationUuid"].as_str().unwrap()).unwrap(),
            Uuid::parse_str(vector["previewKeyId"].as_str().unwrap()).unwrap(),
            &private_key,
            DateTime::parse_from_rfc3339(vector["openAt"].as_str().unwrap())
                .unwrap()
                .with_timezone(&Utc),
        )
        .expect("Rust crypto must open TS-generated vector");
        assert_eq!(
            opened.preview,
            vector["expected"]["preview"].as_str().unwrap()
        );
        assert_eq!(opened.kind, vector["expected"]["kind"].as_str().unwrap());
    }
}
