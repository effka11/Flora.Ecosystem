//! Слепая квитанция FSCP-FRANK (Documents/fscp/franking.md §4.3).
//! Kernel без sqlx/axum: payload + Ed25519 sign/verify. HMAC жалобы — на клиенте.

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use uuid::Uuid;

use crate::FLORA_NAMESPACE_DNS_SCOPE;

pub const FSCP_FRANKING_RECEIPT_CONTEXT_V1: &str = "flora.fscp.franking-receipt.v1";

#[derive(Debug, Clone)]
pub struct FrankReceiptContextV1 {
    pub frank_tag_base64_url: String,
    pub message_uuid: Uuid,
    pub conversation_uuid: Uuid,
    pub sender_user_uuid: Uuid,
    pub receiver_user_uuid: Uuid,
    /// RFC3339 UTC, миллисекунды — байт-в-байт в payload.
    pub server_received_at: String,
}

pub fn frank_receipt_payload_v1(ctx: &FrankReceiptContextV1) -> String {
    [
        FSCP_FRANKING_RECEIPT_CONTEXT_V1,
        ctx.frank_tag_base64_url.as_str(),
        &ctx.message_uuid.to_string().to_lowercase(),
        &ctx.conversation_uuid.to_string().to_lowercase(),
        &ctx.sender_user_uuid.to_string().to_lowercase(),
        &ctx.receiver_user_uuid.to_string().to_lowercase(),
        ctx.server_received_at.as_str(),
    ]
    .join(" | ")
}

pub fn franking_public_key(seed: &[u8; 32]) -> [u8; 32] {
    SigningKey::from_bytes(seed).verifying_key().to_bytes()
}

pub fn server_franking_key_id(public_key: &[u8; 32]) -> Uuid {
    Uuid::new_v5(&FLORA_NAMESPACE_DNS_SCOPE, public_key)
}

pub fn sign_frank_receipt(seed: &[u8; 32], payload_utf8: &str) -> [u8; 64] {
    SigningKey::from_bytes(seed)
        .sign(payload_utf8.as_bytes())
        .to_bytes()
}

pub fn verify_frank_receipt(
    public_key: &[u8; 32],
    payload_utf8: &str,
    signature: &[u8; 64],
) -> bool {
    let Ok(vk) = VerifyingKey::from_bytes(public_key) else {
        return false;
    };
    vk.verify(payload_utf8.as_bytes(), &Signature::from_bytes(signature))
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use std::path::PathBuf;

    fn vector() -> serde_json::Value {
        let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        for _ in 0..4 {
            path.pop();
        }
        path.push("Documents");
        path.push("test-vectors");
        path.push("franking-v1.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("нет {}: {e}", path.display()));
        serde_json::from_str(&raw).expect("franking-v1.json")
    }

    fn b64u32(s: &str) -> [u8; 32] {
        URL_SAFE_NO_PAD.decode(s).unwrap().try_into().unwrap()
    }

    fn b64u64(s: &str) -> [u8; 64] {
        URL_SAFE_NO_PAD.decode(s).unwrap().try_into().unwrap()
    }

    #[test]
    fn receipt_payload_and_signature_match_golden() {
        let v = vector();
        let uu = &v["uuids"];
        let ctx = FrankReceiptContextV1 {
            frank_tag_base64_url: v["frankTagBase64Url"].as_str().unwrap().into(),
            message_uuid: uu["messageUuid"].as_str().unwrap().parse().unwrap(),
            conversation_uuid: uu["conversationUuid"].as_str().unwrap().parse().unwrap(),
            sender_user_uuid: uu["senderUserUuid"].as_str().unwrap().parse().unwrap(),
            receiver_user_uuid: uu["receiverUserUuid"].as_str().unwrap().parse().unwrap(),
            server_received_at: v["receipt"]["serverReceivedAt"].as_str().unwrap().into(),
        };
        let payload = frank_receipt_payload_v1(&ctx);
        assert_eq!(payload, v["receiptPayloadUtf8"].as_str().unwrap());

        let seed = b64u32(
            v["server"]["frankingSigningSeedBase64Url"]
                .as_str()
                .unwrap(),
        );
        let pk = franking_public_key(&seed);
        assert_eq!(
            URL_SAFE_NO_PAD.encode(pk),
            v["server"]["frankingPublicKeyBase64Url"].as_str().unwrap()
        );
        let sig = sign_frank_receipt(&seed, &payload);
        assert_eq!(
            URL_SAFE_NO_PAD.encode(sig),
            v["receipt"]["signatureBase64Url"].as_str().unwrap()
        );
        assert!(verify_frank_receipt(&pk, &payload, &sig));
        let tampered = b64u64(
            v["negatives"][2]["receiptSignatureBase64Url"]
                .as_str()
                .unwrap(),
        );
        assert!(!verify_frank_receipt(&pk, &payload, &tampered));
    }
}
