//! Ed25519-подписи над доменно-таггированным сообщением (FGP-CRYPTO §1: RFC 8032,
//! `ed25519-dalek`, без C-зависимостей).
//!
//! DS-механизм подписи — префикс сообщения меткой из [`crate::ds`] (`метка ‖ payload`),
//! как в FEP/FSCP: `derive_key` применим к хешам/PRF, подпись же обязана покрывать
//! саму метку. Ядро **не генерирует** ключей (нет OsRng в графе — чистая сборка
//! wasm32): генерация живёт на устройствах пользователей (клиентские SDK) и в
//! инфраструктуре модуля; здесь — только детерминированная подпись готовым ключом
//! и верификация.

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};

/// Публичный ключ Ed25519 (32 байта).
pub type PublicKey = [u8; 32];

/// Подпись Ed25519 (64 байта).
pub type SignatureBytes = [u8; 64];

fn tagged_message(label: &str, payload: &[u8]) -> Vec<u8> {
    let mut message = Vec::with_capacity(label.len() + payload.len());
    message.extend_from_slice(label.as_bytes());
    message.extend_from_slice(payload);
    message
}

/// Подписать `payload` с доменной меткой `label` секретным ключом (32-байтовый seed).
pub fn sign(label: &str, payload: &[u8], secret_seed: &[u8; 32]) -> SignatureBytes {
    SigningKey::from_bytes(secret_seed)
        .sign(&tagged_message(label, payload))
        .to_bytes()
}

/// Публичный ключ из секретного seed (для тестов, витнесс-демонов и клиентских SDK).
pub fn public_key(secret_seed: &[u8; 32]) -> PublicKey {
    SigningKey::from_bytes(secret_seed)
        .verifying_key()
        .to_bytes()
}

/// Проверить подпись над `label ‖ payload`. Невалидный ключ (не точка кривой) — `false`.
pub fn verify(
    label: &str,
    payload: &[u8],
    signature: &SignatureBytes,
    public_key: &PublicKey,
) -> bool {
    let Ok(key) = VerifyingKey::from_bytes(public_key) else {
        return false;
    };
    key.verify(
        &tagged_message(label, payload),
        &Signature::from_bytes(signature),
    )
    .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ds;

    const SEED: [u8; 32] = [42u8; 32];

    #[test]
    fn sign_verify_roundtrip() {
        let sig = sign(ds::CIVIC_SIGN, b"payload", &SEED);
        let pk = public_key(&SEED);
        assert!(verify(ds::CIVIC_SIGN, b"payload", &sig, &pk));
    }

    #[test]
    fn wrong_label_fails() {
        let sig = sign(ds::CIVIC_SIGN, b"payload", &SEED);
        let pk = public_key(&SEED);
        assert!(!verify(ds::LOG_STH, b"payload", &sig, &pk));
    }

    #[test]
    fn tampered_payload_fails() {
        let sig = sign(ds::CIVIC_SIGN, b"payload", &SEED);
        let pk = public_key(&SEED);
        assert!(!verify(ds::CIVIC_SIGN, b"PAYLOAD", &sig, &pk));
    }

    #[test]
    fn invalid_public_key_fails_closed() {
        let sig = sign(ds::CIVIC_SIGN, b"payload", &SEED);
        // 32 байта 0xFF — не каноническая точка Edwards25519.
        assert!(!verify(ds::CIVIC_SIGN, b"payload", &sig, &[0xFF; 32]));
    }

    #[test]
    fn signing_is_deterministic() {
        // Ed25519 (RFC 8032) — детерминированная схема: одинаковый вход → одинаковая подпись.
        assert_eq!(
            sign(ds::CIVIC_SIGN, b"x", &SEED),
            sign(ds::CIVIC_SIGN, b"x", &SEED)
        );
    }
}
