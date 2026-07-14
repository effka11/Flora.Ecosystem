//! Ed25519-подписи над доменно-тегированным сообщением (FGP-CRYPTO §1: RFC 8032,
//! `ed25519-dalek`, без C-зависимостей).
//!
//! Ядро **не генерирует** ключей (нет OsRng в графе — чистая сборка wasm32): ключи живут
//! на устройствах пользователей (клиентские SDK) и в инфраструктуре модуля; здесь — только
//! детерминированная подпись готовым ключом и верификация.

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};

use crate::error::EconomyError;

/// Публичный ключ аккаунта (32 байта Ed25519).
pub type PublicKeyBytes = [u8; 32];

/// Подпись (64 байта Ed25519).
pub type SignatureBytes = [u8; 64];

/// Подписать `payload` с доменной меткой `label` секретным ключом (32-байтовый seed).
pub fn sign(label: &str, payload: &[u8], secret_seed: &[u8; 32]) -> SignatureBytes {
    let key = SigningKey::from_bytes(secret_seed);
    let mut message = Vec::with_capacity(label.len() + payload.len());
    message.extend_from_slice(label.as_bytes());
    message.extend_from_slice(payload);
    key.sign(&message).to_bytes()
}

/// Публичный ключ из секретного seed (для тестов и клиентских SDK).
pub fn public_key(secret_seed: &[u8; 32]) -> PublicKeyBytes {
    SigningKey::from_bytes(secret_seed)
        .verifying_key()
        .to_bytes()
}

/// Проверить подпись над `label ‖ payload`.
pub fn verify(
    label: &str,
    payload: &[u8],
    signature: &SignatureBytes,
    public_key: &PublicKeyBytes,
) -> Result<(), EconomyError> {
    let key = VerifyingKey::from_bytes(public_key).map_err(|_| EconomyError::InvalidPublicKey)?;
    let mut message = Vec::with_capacity(label.len() + payload.len());
    message.extend_from_slice(label.as_bytes());
    message.extend_from_slice(payload);
    key.verify(&message, &Signature::from_bytes(signature))
        .map_err(|_| EconomyError::InvalidSignature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain;

    const SEED: [u8; 32] = [42u8; 32];

    #[test]
    fn sign_verify_roundtrip() {
        let sig = sign(domain::TRANSFER_AUTH, b"payload", &SEED);
        let pk = public_key(&SEED);
        assert!(verify(domain::TRANSFER_AUTH, b"payload", &sig, &pk).is_ok());
    }

    #[test]
    fn wrong_label_fails() {
        let sig = sign(domain::TRANSFER_AUTH, b"payload", &SEED);
        let pk = public_key(&SEED);
        assert!(verify(domain::TRUSTLINE_AUTH, b"payload", &sig, &pk).is_err());
    }

    #[test]
    fn tampered_payload_fails() {
        let sig = sign(domain::TRANSFER_AUTH, b"payload", &SEED);
        let pk = public_key(&SEED);
        assert!(verify(domain::TRANSFER_AUTH, b"PAYLOAD", &sig, &pk).is_err());
    }

    #[test]
    fn signing_is_deterministic() {
        // Ed25519 (RFC 8032) — детерминированная схема: одинаковый вход → одинаковая подпись.
        let a = sign(domain::TRANSFER_AUTH, b"x", &SEED);
        let b = sign(domain::TRANSFER_AUTH, b"x", &SEED);
        assert_eq!(a, b);
    }
}
