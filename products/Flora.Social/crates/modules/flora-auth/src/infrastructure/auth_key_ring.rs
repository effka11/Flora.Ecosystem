//! Auth-owned XChaCha20-Poly1305 key ring (replay-grant'ы, TOTP at-rest).
//!
//! Кольцо одно, префикс конфигурации — параметр: у replay-ключей и TOTP-ключей
//! разные жизненные циклы, поэтому каждая подсистема поднимает своё кольцо.
//! `active_key_id` шифрует новые значения, старые key id остаются только для
//! расшифровки. Startup fail-fast без active key (см. `from_config`).
//!
//! Формат конфигурации (плоские ключи, как в остальном Flora config):
//! - `<prefix>:ActiveKeyId` — id активного ключа.
//! - `<prefix>:KeyIds:0`, `:1`, … — все известные key id.
//! - `<prefix>:Key:<id>` — base64 (standard) 32-байтного ключа.

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

impl KeyRingError {
    /// Текст с префиксом конфигурации. Вызывающий слой знает, какое кольцо он
    /// поднимает (`Auth:ReplayKeyRing`, `Auth:TotpKeyRing`), а сами ошибки
    /// остаются префикс-независимыми.
    pub fn with_prefix(&self, prefix: &str) -> String {
        match self {
            KeyRingError::MissingActiveKey => format!("{prefix}:ActiveKeyId не задан"),
            KeyRingError::ActiveKeyNotConfigured => {
                format!("активный key id отсутствует среди {prefix}:Key:*")
            }
            KeyRingError::InvalidKeyMaterial(id) => {
                format!("{prefix}:Key:{id} не base64/не 32 байта")
            }
        }
    }
}

impl std::fmt::Display for KeyRingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeyRingError::MissingActiveKey => write!(f, "ActiveKeyId не задан"),
            KeyRingError::ActiveKeyNotConfigured => {
                write!(f, "активный key id отсутствует среди Key:*")
            }
            KeyRingError::InvalidKeyMaterial(id) => {
                write!(f, "key '{id}' не base64/не 32 байта")
            }
        }
    }
}

impl std::error::Error for KeyRingError {}

/// Ошибка AEAD-операции. Никогда не приводит к ложному отзыву сессии —
/// вызывающий слой обязан вернуть transient 5xx.
#[derive(Debug, PartialEq, Eq)]
pub enum KeyRingCryptoError {
    /// Key id не найден в key ring (например, удалён после ротации).
    UnknownKeyId(String),
    /// Nonce неверной длины.
    BadNonce,
    /// Проверка тега/расшифровка не удалась (corruption/подмена).
    Decrypt,
}

impl std::fmt::Display for KeyRingCryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeyRingCryptoError::UnknownKeyId(id) => write!(f, "неизвестный key id '{id}'"),
            KeyRingCryptoError::BadNonce => write!(f, "nonce неверной длины"),
            KeyRingCryptoError::Decrypt => {
                write!(f, "ciphertext не расшифрован (corruption)")
            }
        }
    }
}

impl std::error::Error for KeyRingCryptoError {}

/// Результат шифрования: key id + nonce + ciphertext.
#[derive(Debug, Clone)]
pub struct SealedBlob {
    pub key_id: String,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

/// Кольцо ключей: активный ключ шифрует, все ключи расшифровывают.
pub struct AuthKeyRing {
    active_key_id: String,
    keys: HashMap<String, [u8; KEY_LEN]>,
}

// Redact key material из Debug: логируем только id и количество ключей.
impl std::fmt::Debug for AuthKeyRing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthKeyRing")
            .field("active_key_id", &self.active_key_id)
            .field("keys", &format_args!("<{} redacted>", self.keys.len()))
            .finish()
    }
}

impl AuthKeyRing {
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

    /// Чтение key ring из конфигурации под префиксом `prefix`
    /// (`Auth:ReplayKeyRing` / `Auth:TotpKeyRing`). `Ok(None)` — key ring не
    /// сконфигурирован (нет active key id и нет ключей); вызывающий решает,
    /// ошибка это или нет. `Err(..)` — конфигурация неполна/битая.
    pub fn from_config(
        cfg: &flora_shared::config::FloraConfig,
        prefix: &str,
    ) -> Result<Option<Self>, KeyRingError> {
        let active = cfg
            .get_non_empty(&format!("{prefix}:ActiveKeyId"))
            .map(str::to_string);
        let key_ids = cfg.get_string_array(&format!("{prefix}:KeyIds"));
        if active.is_none() && key_ids.is_empty() {
            return Ok(None);
        }
        let active = active.ok_or(KeyRingError::MissingActiveKey)?;

        let mut keys = HashMap::new();
        for id in key_ids {
            let raw = cfg
                .get_non_empty(&format!("{prefix}:Key:{id}"))
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

    /// Зашифровать значение активным ключом со случайным 24-байтным nonce.
    pub fn seal(&self, aad: &[u8], plaintext: &[u8]) -> SealedBlob {
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
        SealedBlob {
            key_id: self.active_key_id.clone(),
            nonce: nonce.to_vec(),
            ciphertext,
        }
    }

    /// Расшифровать значение по key_id + nonce + aad. Любая ошибка — transient,
    /// не отзыв.
    pub fn open(
        &self,
        key_id: &str,
        nonce: &[u8],
        aad: &[u8],
        ciphertext: &[u8],
    ) -> Result<Vec<u8>, KeyRingCryptoError> {
        let key = self
            .keys
            .get(key_id)
            .ok_or_else(|| KeyRingCryptoError::UnknownKeyId(key_id.to_string()))?;
        if nonce.len() != NONCE_LEN {
            return Err(KeyRingCryptoError::BadNonce);
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
            .map_err(|_| KeyRingCryptoError::Decrypt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPLAY_PREFIX: &str = "Auth:ReplayKeyRing";

    fn ring() -> AuthKeyRing {
        let mut keys = HashMap::new();
        keys.insert("k-active".to_string(), [7_u8; KEY_LEN]);
        keys.insert("k-old".to_string(), [9_u8; KEY_LEN]);
        AuthKeyRing::new("k-active", keys).unwrap()
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
            Err(KeyRingCryptoError::Decrypt)
        );
    }

    #[test]
    fn unknown_or_removed_key_id_is_transient_not_revoke() {
        let ring = ring();
        let sealed = ring.seal(b"aad", b"payload");
        assert_eq!(
            ring.open("k-deleted", &sealed.nonce, b"aad", &sealed.ciphertext),
            Err(KeyRingCryptoError::UnknownKeyId("k-deleted".into()))
        );
    }

    #[test]
    fn decrypt_only_old_key_still_opens_its_ciphertext() {
        // значение, зашифрованное старым активным ключом, читается после ротации.
        let mut keys = HashMap::new();
        keys.insert("k-old".to_string(), [3_u8; KEY_LEN]);
        let old_ring = AuthKeyRing::new("k-old", keys.clone()).unwrap();
        let sealed = old_ring.seal(b"aad", b"payload");

        keys.insert("k-new".to_string(), [4_u8; KEY_LEN]);
        let rotated = AuthKeyRing::new("k-new", keys).unwrap();
        assert_eq!(rotated.active_key_id(), "k-new");
        let opened = rotated
            .open(&sealed.key_id, &sealed.nonce, b"aad", &sealed.ciphertext)
            .unwrap();
        assert_eq!(opened, b"payload");
    }

    #[test]
    fn missing_active_key_fails_fast() {
        assert_eq!(
            AuthKeyRing::new("", HashMap::new()).unwrap_err(),
            KeyRingError::MissingActiveKey
        );
        assert_eq!(
            AuthKeyRing::new("absent", HashMap::new()).unwrap_err(),
            KeyRingError::ActiveKeyNotConfigured
        );
    }

    #[test]
    fn from_config_none_when_unconfigured() {
        let cfg = flora_shared::config::FloraConfig::from_layers("Production", &[], &[]);
        assert!(
            AuthKeyRing::from_config(&cfg, REPLAY_PREFIX)
                .unwrap()
                .is_none()
        );
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
        let ring = AuthKeyRing::from_config(&cfg, REPLAY_PREFIX)
            .unwrap()
            .unwrap();
        assert_eq!(ring.active_key_id(), "k1");
    }

    #[test]
    fn from_config_ignores_other_ring_prefix() {
        let key_b64 = STANDARD.encode([2_u8; KEY_LEN]);
        let cfg = flora_shared::config::FloraConfig::from_layers(
            "Production",
            &[serde_json::json!({
                "Auth": {
                    "TotpKeyRing": {
                        "ActiveKeyId": "t1",
                        "KeyIds": ["t1"],
                        "Key": { "t1": key_b64 }
                    }
                }
            })],
            &[],
        );
        assert!(
            AuthKeyRing::from_config(&cfg, REPLAY_PREFIX)
                .unwrap()
                .is_none()
        );
        let totp = AuthKeyRing::from_config(&cfg, "Auth:TotpKeyRing")
            .unwrap()
            .unwrap();
        assert_eq!(totp.active_key_id(), "t1");
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
            AuthKeyRing::from_config(&cfg, REPLAY_PREFIX),
            Err(KeyRingError::InvalidKeyMaterial(_))
        ));
    }

    #[test]
    fn key_material_must_be_32_bytes() {
        let short_b64 = STANDARD.encode([1_u8; 16]);
        let cfg = flora_shared::config::FloraConfig::from_layers(
            "Production",
            &[serde_json::json!({
                "Auth": {
                    "ReplayKeyRing": {
                        "ActiveKeyId": "k1",
                        "KeyIds": ["k1"],
                        "Key": { "k1": short_b64 }
                    }
                }
            })],
            &[],
        );
        assert_eq!(
            AuthKeyRing::from_config(&cfg, REPLAY_PREFIX).unwrap_err(),
            KeyRingError::InvalidKeyMaterial("k1".into())
        );
    }

    #[test]
    fn error_text_is_prefixed_at_the_caller_boundary() {
        assert_eq!(
            KeyRingError::MissingActiveKey.with_prefix("Auth:TotpKeyRing"),
            "Auth:TotpKeyRing:ActiveKeyId не задан"
        );
        assert_eq!(
            KeyRingError::ActiveKeyNotConfigured.with_prefix("Auth:ReplayKeyRing"),
            "активный key id отсутствует среди Auth:ReplayKeyRing:Key:*"
        );
        assert_eq!(
            KeyRingError::InvalidKeyMaterial("k1".into()).with_prefix("Auth:TotpKeyRing"),
            "Auth:TotpKeyRing:Key:k1 не base64/не 32 байта"
        );
    }

    #[test]
    fn debug_redacts_key_material() {
        let rendered = format!("{:?}", ring());
        assert!(rendered.contains("<2 redacted>"));
        assert!(rendered.contains("k-active"));
    }
}
