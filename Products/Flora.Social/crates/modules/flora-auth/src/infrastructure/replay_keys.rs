//! Auth-owned XChaCha20-Poly1305 key ring для replay-grant'ов (plan §2).
//!
//! Отдельный от `Jwt:Secret` ключ: `active_key_id` шифрует новые grant'ы,
//! старые key id остаются только для расшифровки, пока не истёк replay TTL и
//! cleanup их не убрал. Startup fail-fast без active key (см. `from_config`).
//!
//! Формат конфигурации (плоские ключи, как в остальном Flora config):
//! - `Auth:ReplayKeyRing:ActiveKeyId` — id активного ключа.
//! - `Auth:ReplayKeyRing:KeyIds:0`, `:1`, … — все известные key id.
//! - `Auth:ReplayKeyRing:Key:<id>` — base64 (standard) 32-байтного ключа.

use std::collections::HashMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use getrandom::fill;

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 24;

#[derive(Debug, PartialEq, Eq)]
pub enum KeyRingError {
    /// Нет активного key id (fail-fast на старте).
    MissingActiveKey,
    /// Активный key id не найден среди ключей.
    ActiveKeyNotConfigured,
    /// Ключ не base64 или не 32 байта.
    InvalidKeyMaterial(String),
}

impl std::fmt::Display for KeyRingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeyRingError::MissingActiveKey => {
                write!(f, "Auth:ReplayKeyRing:ActiveKeyId не задан")
            }
            KeyRingError::ActiveKeyNotConfigured => {
                write!(
                    f,
                    "активный replay key id отсутствует среди Auth:ReplayKeyRing:Key:*"
                )
            }
            KeyRingError::InvalidKeyMaterial(id) => {
                write!(f, "replay key '{id}' не base64/не 32 байта")
            }
        }
    }
}

impl std::error::Error for KeyRingError {}

/// Ошибка AEAD-операции. Никогда не приводит к ложному отзыву сессии —
/// вызывающий слой обязан вернуть transient 5xx.
#[derive(Debug, PartialEq, Eq)]
pub enum ReplayCryptoError {
    /// Key id не найден в key ring (например, удалён после ротации).
    UnknownKeyId(String),
    /// Nonce неверной длины.
    BadNonce,
    /// Проверка тега/расшифровка не удалась (corruption/подмена).
    Decrypt,
}

impl std::fmt::Display for ReplayCryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReplayCryptoError::UnknownKeyId(id) => write!(f, "неизвестный replay key id '{id}'"),
            ReplayCryptoError::BadNonce => write!(f, "replay nonce неверной длины"),
            ReplayCryptoError::Decrypt => {
                write!(f, "replay ciphertext не расшифрован (corruption)")
            }
        }
    }
}

impl std::error::Error for ReplayCryptoError {}

/// Результат шифрования grant'а.
#[derive(Debug, Clone)]
pub struct SealedGrant {
    pub key_id: String,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

/// Кольцо ключей: активный ключ шифрует, все ключи расшифровывают.
pub struct ReplayKeyRing {
    active_key_id: String,
    keys: HashMap<String, [u8; KEY_LEN]>,
}

// Redact key material из Debug: логируем только id и количество ключей.
impl std::fmt::Debug for ReplayKeyRing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReplayKeyRing")
            .field("active_key_id", &self.active_key_id)
            .field("keys", &format_args!("<{} redacted>", self.keys.len()))
            .finish()
    }
}

impl ReplayKeyRing {
    /// Явная сборка (тесты / программная конфигурация). Fail-fast если активного
    /// ключа нет среди `keys`.
    pub fn new(
        active_key_id: impl Into<String>,
        keys: HashMap<String, [u8; KEY_LEN]>,
    ) -> Result<Self, KeyRingError> {
        let active_key_id = active_key_id.into();
        if active_key_id.is_empty() {
            return Err(KeyRingError::MissingActiveKey);
        }
        if !keys.contains_key(&active_key_id) {
            return Err(KeyRingError::ActiveKeyNotConfigured);
        }
        Ok(Self {
            active_key_id,
            keys,
        })
    }

    /// Чтение key ring из конфигурации. `Ok(None)` — key ring не сконфигурирован
    /// (нет active key id и нет ключей); вызывающий решает, ошибка это или нет.
    /// `Err(..)` — конфигурация неполна/битая (startup fail-fast).
    pub fn from_config(
        cfg: &flora_shared::config::FloraConfig,
    ) -> Result<Option<Self>, KeyRingError> {
        let active = cfg
            .get_non_empty("Auth:ReplayKeyRing:ActiveKeyId")
            .map(str::to_string);
        let key_ids = cfg.get_string_array("Auth:ReplayKeyRing:KeyIds");
        if active.is_none() && key_ids.is_empty() {
            return Ok(None);
        }
        let active = active.ok_or(KeyRingError::MissingActiveKey)?;

        let mut keys = HashMap::new();
        for id in key_ids {
            let raw = cfg
                .get_non_empty(&format!("Auth:ReplayKeyRing:Key:{id}"))
                .ok_or_else(|| KeyRingError::InvalidKeyMaterial(id.clone()))?;
            let bytes = STANDARD
                .decode(raw)
                .map_err(|_| KeyRingError::InvalidKeyMaterial(id.clone()))?;
            let key: [u8; KEY_LEN] = bytes
                .try_into()
                .map_err(|_| KeyRingError::InvalidKeyMaterial(id.clone()))?;
            keys.insert(id, key);
        }
        Self::new(active, keys).map(Some)
    }

    pub fn active_key_id(&self) -> &str {
        &self.active_key_id
    }

    /// Зашифровать grant активным ключом со случайным 24-байтным nonce.
    pub fn seal(&self, aad: &[u8], plaintext: &[u8]) -> SealedGrant {
        let key = self
            .keys
            .get(&self.active_key_id)
            .expect("active key присутствует (проверено в new)");
        let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
        let mut nonce = [0_u8; NONCE_LEN];
        fill(&mut nonce).expect("OS CSPRNG");
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .expect("XChaCha20-Poly1305 seal бесконечно не падает");
        SealedGrant {
            key_id: self.active_key_id.clone(),
            nonce: nonce.to_vec(),
            ciphertext,
        }
    }

    /// Расшифровать grant по key_id + nonce + aad. Любая ошибка — transient, не отзыв.
    pub fn open(
        &self,
        key_id: &str,
        nonce: &[u8],
        aad: &[u8],
        ciphertext: &[u8],
    ) -> Result<Vec<u8>, ReplayCryptoError> {
        let key = self
            .keys
            .get(key_id)
            .ok_or_else(|| ReplayCryptoError::UnknownKeyId(key_id.to_string()))?;
        if nonce.len() != NONCE_LEN {
            return Err(ReplayCryptoError::BadNonce);
        }
        let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
        cipher
            .decrypt(
                XNonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad,
                },
            )
            .map_err(|_| ReplayCryptoError::Decrypt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring() -> ReplayKeyRing {
        let mut keys = HashMap::new();
        keys.insert("k-active".to_string(), [7_u8; KEY_LEN]);
        keys.insert("k-old".to_string(), [9_u8; KEY_LEN]);
        ReplayKeyRing::new("k-active", keys).unwrap()
    }

    #[test]
    fn seal_open_roundtrip_with_active_key() {
        let ring = ring();
        let sealed = ring.seal(b"aad-context", b"grant-plaintext");
        assert_eq!(sealed.key_id, "k-active");
        assert_eq!(sealed.nonce.len(), NONCE_LEN);
        let opened = ring
            .open(
                "k-active",
                &sealed.nonce,
                b"aad-context",
                &sealed.ciphertext,
            )
            .unwrap();
        assert_eq!(opened, b"grant-plaintext");
    }

    #[test]
    fn wrong_aad_fails_to_open() {
        let ring = ring();
        let sealed = ring.seal(b"aad-a", b"payload");
        assert_eq!(
            ring.open("k-active", &sealed.nonce, b"aad-b", &sealed.ciphertext),
            Err(ReplayCryptoError::Decrypt)
        );
    }

    #[test]
    fn unknown_or_removed_key_id_is_transient_not_revoke() {
        let ring = ring();
        let sealed = ring.seal(b"aad", b"payload");
        assert_eq!(
            ring.open("k-deleted", &sealed.nonce, b"aad", &sealed.ciphertext),
            Err(ReplayCryptoError::UnknownKeyId("k-deleted".into()))
        );
    }

    #[test]
    fn decrypt_only_old_key_still_opens_its_ciphertext() {
        // grant, зашифрованный старым активным ключом, читается после ротации.
        let mut keys = HashMap::new();
        keys.insert("k-old".to_string(), [3_u8; KEY_LEN]);
        let old_ring = ReplayKeyRing::new("k-old", keys.clone()).unwrap();
        let sealed = old_ring.seal(b"aad", b"payload");

        keys.insert("k-new".to_string(), [4_u8; KEY_LEN]);
        let rotated = ReplayKeyRing::new("k-new", keys).unwrap();
        assert_eq!(rotated.active_key_id(), "k-new");
        let opened = rotated
            .open(&sealed.key_id, &sealed.nonce, b"aad", &sealed.ciphertext)
            .unwrap();
        assert_eq!(opened, b"payload");
    }

    #[test]
    fn missing_active_key_fails_fast() {
        assert_eq!(
            ReplayKeyRing::new("", HashMap::new()).unwrap_err(),
            KeyRingError::MissingActiveKey
        );
        assert_eq!(
            ReplayKeyRing::new("absent", HashMap::new()).unwrap_err(),
            KeyRingError::ActiveKeyNotConfigured
        );
    }

    #[test]
    fn from_config_none_when_unconfigured() {
        let cfg = flora_shared::config::FloraConfig::from_layers("Production", &[], &[]);
        assert!(ReplayKeyRing::from_config(&cfg).unwrap().is_none());
    }

    #[test]
    fn from_config_reads_active_and_keys() {
        let key_b64 = STANDARD.encode([1_u8; KEY_LEN]);
        let cfg = flora_shared::config::FloraConfig::from_layers(
            "Production",
            &[serde_json::json!({
                "Auth": {
                    "ReplayKeyRing": {
                        "ActiveKeyId": "k1",
                        "KeyIds": ["k1"],
                        "Key": { "k1": key_b64 }
                    }
                }
            })],
            &[],
        );
        let ring = ReplayKeyRing::from_config(&cfg).unwrap().unwrap();
        assert_eq!(ring.active_key_id(), "k1");
    }

    #[test]
    fn from_config_active_without_key_material_fails_fast() {
        let cfg = flora_shared::config::FloraConfig::from_layers(
            "Production",
            &[serde_json::json!({
                "Auth": { "ReplayKeyRing": { "ActiveKeyId": "k1", "KeyIds": ["k1"] } }
            })],
            &[],
        );
        assert!(matches!(
            ReplayKeyRing::from_config(&cfg),
            Err(KeyRingError::InvalidKeyMaterial(_))
        ));
    }
}
