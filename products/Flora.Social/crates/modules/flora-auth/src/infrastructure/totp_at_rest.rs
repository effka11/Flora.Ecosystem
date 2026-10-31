//! At-rest кодирование TOTP-секрета (`auth-totp-plaintext`).
//!
//! Модуль Auth владеет и данными, и ключом, поэтому шифрование живёт здесь, а
//! `repo.rs` остаётся чистым SQL. Хранимое значение — либо legacy base32
//! (до бэкфилла), либо `v1:<keyId>:<nonce_b64>:<ct_b64>`.
//!
//! - AEAD: XChaCha20-Poly1305, отдельное кольцо `Auth:TotpKeyRing` (у него
//!   другой жизненный цикл, чем у replay-ключей: ключ обязан жить, пока
//!   существует хоть одна sealed-строка).
//! - AAD: `flora.auth.totp-secret.v1|<user_uuid>` — строка не переставляется
//!   между аккаунтами.
//!
//! Development работает в режиме [`TotpAtRest::Plain`]: эфемерный `Jwt:Secret`
//! пересоздаётся на рестарте и не может быть стабильным ключом.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use flora_shared::config::FloraConfig;
use uuid::Uuid;

use crate::infrastructure::auth_key_ring::{AuthKeyRing, KeyRingCryptoError};

/// Префикс конфигурации отдельного TOTP-кольца.
pub const TOTP_KEY_RING_PREFIX: &str = "Auth:TotpKeyRing";
/// Домен AAD; версия домена совпадает с версией формата значения.
const AAD_DOMAIN: &str = "flora.auth.totp-secret.v1";
/// Единственная поддерживаемая версия формата.
const ENVELOPE_VERSION: &str = "v1";
const ENVELOPE_PREFIX: &str = "v1:";

#[derive(Debug, PartialEq, Eq)]
pub enum TotpAtRestError {
    /// `required_from_config` в Production без `Auth:TotpKeyRing`.
    MissingKeyRing,
    /// `Auth:TotpKeyRing` неполон или битый (startup fail-fast).
    InvalidConfig(String),
    /// Секрет зашифрован, а ключ не сконфигурирован (dev/legacy-конфиг).
    SealedWithoutKey,
    /// Версия или структура запечатанного значения не распознаны.
    UnknownFormat,
    /// Расшифровка невозможна: неизвестный key id или corruption.
    Crypto(KeyRingCryptoError),
}

impl std::fmt::Display for TotpAtRestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TotpAtRestError::MissingKeyRing => {
                write!(f, "{TOTP_KEY_RING_PREFIX} не задан")
            }
            TotpAtRestError::InvalidConfig(reason) => write!(f, "{reason}"),
            TotpAtRestError::SealedWithoutKey => write!(
                f,
                "TOTP-секрет зашифрован, но {TOTP_KEY_RING_PREFIX} не сконфигурирован"
            ),
            TotpAtRestError::UnknownFormat => write!(f, "неизвестный формат TOTP-секрета"),
            TotpAtRestError::Crypto(error) => write!(f, "TOTP-секрет не расшифрован: {error}"),
        }
    }
}

impl std::error::Error for TotpAtRestError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            TotpAtRestError::Crypto(error) => Some(error),
            _ => None,
        }
    }
}

/// Режим хранения TOTP-секрета: plaintext (dev/tests) или sealed (Production).
pub enum TotpAtRest {
    Plain,
    Sealed(AuthKeyRing),
}

// Ручной Debug: key ring редактирует материал, режим виден в логах.
impl std::fmt::Debug for TotpAtRest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TotpAtRest::Plain => f.write_str("TotpAtRest::Plain"),
            TotpAtRest::Sealed(ring) => f.debug_tuple("TotpAtRest::Sealed").field(ring).finish(),
        }
    }
}

impl TotpAtRest {
    /// Чтение режима из конфигурации. `Ok(None)` — `Auth:TotpKeyRing` не задан
    /// (dev), вызывающий решает, допустимо ли это.
    pub fn from_config(cfg: &FloraConfig) -> Result<Option<Self>, TotpAtRestError> {
        match AuthKeyRing::from_config(cfg, TOTP_KEY_RING_PREFIX) {
            Ok(Some(ring)) => Ok(Some(TotpAtRest::Sealed(ring))),
            Ok(None) => Ok(None),
            Err(error) => Err(TotpAtRestError::InvalidConfig(
                error.with_prefix(TOTP_KEY_RING_PREFIX),
            )),
        }
    }

    /// Production-вариант: без key ring — отказ от старта.
    pub fn required_from_config(cfg: &FloraConfig) -> Result<Self, TotpAtRestError> {
        Self::from_config(cfg)?.ok_or(TotpAtRestError::MissingKeyRing)
    }

    /// Plaintext-режим для dev и тестов.
    pub fn plain() -> Self {
        TotpAtRest::Plain
    }

    pub fn is_sealed(&self) -> bool {
        matches!(self, TotpAtRest::Sealed(_))
    }

    /// Значение для записи в `user_accounts.two_factor_secret`. Публичный
    /// HTTP-контракт setup отдаёт клиенту исходный base32 из памяти, поэтому
    /// метод возвращает именно хранимую форму.
    pub fn seal(&self, user_uuid: Uuid, base32_secret: &str) -> String {
        match self {
            TotpAtRest::Plain => base32_secret.to_string(),
            TotpAtRest::Sealed(ring) => {
                let sealed = ring.seal(&totp_aad(user_uuid), base32_secret.as_bytes());
                format!(
                    "{ENVELOPE_PREFIX}{}:{}:{}",
                    sealed.key_id,
                    STANDARD.encode(&sealed.nonce),
                    STANDARD.encode(&sealed.ciphertext)
                )
            }
        }
    }

    /// base32-секрет для проверки кода. Legacy-строка проходит как есть в обоих
    /// режимах (совместимость до бэкфилла); `v1:` в режиме `Plain` — явная
    /// ошибка, а не попытка трактовать шифротекст как base32.
    pub fn open(&self, user_uuid: Uuid, stored: &str) -> Result<String, TotpAtRestError> {
        let stored = stored.trim();
        if is_plaintext_row(stored) {
            // Base32-алфавит не содержит ':', поэтому двоеточие означает
            // запечатанный конверт неизвестной версии.
            if stored.contains(':') {
                return Err(TotpAtRestError::UnknownFormat);
            }
            return Ok(stored.to_string());
        }
        let ring = match self {
            TotpAtRest::Plain => return Err(TotpAtRestError::SealedWithoutKey),
            TotpAtRest::Sealed(ring) => ring,
        };
        let (key_id, nonce, ciphertext) = split_envelope(stored)?;
        let nonce = STANDARD
            .decode(nonce)
            .map_err(|_| TotpAtRestError::UnknownFormat)?;
        let ciphertext = STANDARD
            .decode(ciphertext)
            .map_err(|_| TotpAtRestError::UnknownFormat)?;
        let plaintext = ring
            .open(key_id, &nonce, &totp_aad(user_uuid), &ciphertext)
            .map_err(TotpAtRestError::Crypto)?;
        String::from_utf8(plaintext).map_err(|_| TotpAtRestError::UnknownFormat)
    }
}

/// `true` — значение хранится как legacy plaintext (не распознано как `v1:`).
/// Используется как зеркало SQL-предиката бэкфилла (`NOT LIKE 'v1:%'`).
pub fn is_plaintext_row(stored: &str) -> bool {
    !stored.starts_with(ENVELOPE_PREFIX)
}

fn totp_aad(user_uuid: Uuid) -> Vec<u8> {
    format!("{AAD_DOMAIN}|{user_uuid}").into_bytes()
}

/// `v1:<keyId>:<nonce_b64>:<ct_b64>` → части. Версия и число полей — строго.
fn split_envelope(stored: &str) -> Result<(&str, &str, &str), TotpAtRestError> {
    let mut parts = stored.split(':');
    if parts.next() != Some(ENVELOPE_VERSION) {
        return Err(TotpAtRestError::UnknownFormat);
    }
    let (Some(key_id), Some(nonce), Some(ciphertext), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(TotpAtRestError::UnknownFormat);
    };
    if key_id.is_empty() || nonce.is_empty() || ciphertext.is_empty() {
        return Err(TotpAtRestError::UnknownFormat);
    }
    Ok((key_id, nonce, ciphertext))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const KEY_LEN: usize = 32;

    fn user() -> Uuid {
        Uuid::parse_str("00000000-0000-0000-0000-0000000000aa").unwrap()
    }

    fn other_user() -> Uuid {
        Uuid::parse_str("00000000-0000-0000-0000-0000000000bb").unwrap()
    }

    fn sealed(mut keys: HashMap<String, [u8; KEY_LEN]>, active: &str) -> TotpAtRest {
        if !keys.contains_key(active) {
            keys.insert(active.to_string(), [5_u8; KEY_LEN]);
        }
        TotpAtRest::Sealed(AuthKeyRing::new(active, keys).unwrap())
    }

    fn ring_with(ids: &[(&str, u8)]) -> HashMap<String, [u8; KEY_LEN]> {
        ids.iter()
            .map(|(id, byte)| ((*id).to_string(), [*byte; KEY_LEN]))
            .collect()
    }

    #[test]
    fn seal_open_roundtrip_returns_base32() {
        let at_rest = sealed(ring_with(&[("k1", 7)]), "k1");
        let stored = at_rest.seal(user(), "JBSWY3DPEHPK3PXN");
        assert!(stored.starts_with("v1:k1:"));
        assert_eq!(at_rest.open(user(), &stored).unwrap(), "JBSWY3DPEHPK3PXN");
    }

    #[test]
    fn sealed_value_has_four_colon_parts() {
        let at_rest = sealed(ring_with(&[("k1", 7)]), "k1");
        let stored = at_rest.seal(user(), "JBSWY3DPEHPK3PXN");
        assert_eq!(stored.split(':').count(), 4);
    }

    #[test]
    fn foreign_user_uuid_fails_to_open() {
        let at_rest = sealed(ring_with(&[("k1", 7)]), "k1");
        let stored = at_rest.seal(user(), "JBSWY3DPEHPK3PXN");
        assert!(matches!(
            at_rest.open(other_user(), &stored),
            Err(TotpAtRestError::Crypto(KeyRingCryptoError::Decrypt))
        ));
    }

    #[test]
    fn tampered_ciphertext_fails_to_open() {
        let at_rest = sealed(ring_with(&[("k1", 7)]), "k1");
        let stored = at_rest.seal(user(), "JBSWY3DPEHPK3PXN");
        let mut parts: Vec<&str> = stored.split(':').collect();
        let mut ciphertext = parts[3].to_string();
        let last = ciphertext.pop().unwrap();
        ciphertext.push(if last == 'A' { 'B' } else { 'A' });
        parts[3] = &ciphertext;
        let tampered = parts.join(":");
        assert!(matches!(
            at_rest.open(user(), &tampered),
            Err(TotpAtRestError::Crypto(KeyRingCryptoError::Decrypt))
        ));
    }

    #[test]
    fn legacy_base32_passes_through_in_sealed_mode() {
        let at_rest = sealed(ring_with(&[("k1", 7)]), "k1");
        assert_eq!(
            at_rest.open(user(), "JBSWY3DPEHPK3PXN").unwrap(),
            "JBSWY3DPEHPK3PXN"
        );
        assert!(is_plaintext_row("JBSWY3DPEHPK3PXN"));
    }

    #[test]
    fn legacy_base32_passes_through_in_plain_mode() {
        let at_rest = TotpAtRest::plain();
        assert_eq!(
            at_rest.open(user(), "JBSWY3DPEHPK3PXN").unwrap(),
            "JBSWY3DPEHPK3PXN"
        );
        assert_eq!(at_rest.seal(user(), "JBSWY3DPEHPK3PXN"), "JBSWY3DPEHPK3PXN");
        assert!(!at_rest.is_sealed());
    }

    #[test]
    fn sealed_envelope_without_key_ring_is_explicit_error() {
        let stored = sealed(ring_with(&[("k1", 7)]), "k1").seal(user(), "JBSWY3DPEHPK3PXN");
        assert_eq!(
            TotpAtRest::plain().open(user(), &stored).unwrap_err(),
            TotpAtRestError::SealedWithoutKey
        );
    }

    #[test]
    fn unknown_envelope_version_is_not_treated_as_base32() {
        let at_rest = sealed(ring_with(&[("k1", 7)]), "k1");
        assert_eq!(
            at_rest.open(user(), "v2:k1:AAAA:BBBB").unwrap_err(),
            TotpAtRestError::UnknownFormat
        );
        assert_eq!(
            TotpAtRest::plain()
                .open(user(), "v2:k1:AAAA:BBBB")
                .unwrap_err(),
            TotpAtRestError::UnknownFormat
        );
    }

    #[test]
    fn malformed_envelope_is_unknown_format() {
        let at_rest = sealed(ring_with(&[("k1", 7)]), "k1");
        for stored in ["v1:k1:AAAA", "v1::AAAA:BBBB", "v1:k1:AAAA:BBBB:extra"] {
            assert_eq!(
                at_rest.open(user(), stored).unwrap_err(),
                TotpAtRestError::UnknownFormat,
                "value {stored}"
            );
        }
    }

    #[test]
    fn non_base64_parts_are_unknown_format() {
        let at_rest = sealed(ring_with(&[("k1", 7)]), "k1");
        assert_eq!(
            at_rest.open(user(), "v1:k1:*:*").unwrap_err(),
            TotpAtRestError::UnknownFormat
        );
    }

    #[test]
    fn rotation_reads_old_key_while_active_key_changes() {
        let at_rest = sealed(ring_with(&[("k-old", 3)]), "k-old");
        let stored = at_rest.seal(user(), "JBSWY3DPEHPK3PXN");

        let rotated = sealed(ring_with(&[("k-old", 3), ("k-new", 4)]), "k-new");
        assert_eq!(rotated.open(user(), &stored).unwrap(), "JBSWY3DPEHPK3PXN");
        assert!(rotated.seal(user(), "ABC").starts_with("v1:k-new:"));
    }

    #[test]
    fn removed_key_id_is_transient_crypto_error() {
        let stored = sealed(ring_with(&[("k-old", 3)]), "k-old").seal(user(), "JBSWY3DPEHPK3PXN");
        let without_old = sealed(ring_with(&[("k-new", 4)]), "k-new");
        assert_eq!(
            without_old.open(user(), &stored).unwrap_err(),
            TotpAtRestError::Crypto(KeyRingCryptoError::UnknownKeyId("k-old".into()))
        );
    }

    #[test]
    fn from_config_none_when_unconfigured() {
        let cfg = FloraConfig::from_layers("Production", &[], &[]);
        assert!(TotpAtRest::from_config(&cfg).unwrap().is_none());
        assert_eq!(
            TotpAtRest::required_from_config(&cfg).unwrap_err(),
            TotpAtRestError::MissingKeyRing
        );
    }

    #[test]
    fn from_config_builds_sealed_mode() {
        let key_b64 = STANDARD.encode([9_u8; KEY_LEN]);
        let cfg = FloraConfig::from_layers(
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
        let at_rest = TotpAtRest::required_from_config(&cfg).unwrap();
        assert!(at_rest.is_sealed());
        let stored = at_rest.seal(user(), "JBSWY3DPEHPK3PXN");
        assert_eq!(at_rest.open(user(), &stored).unwrap(), "JBSWY3DPEHPK3PXN");
    }

    #[test]
    fn from_config_incomplete_ring_is_config_error() {
        let cfg = FloraConfig::from_layers(
            "Production",
            &[serde_json::json!({
                "Auth": { "TotpKeyRing": { "ActiveKeyId": "t1", "KeyIds": ["t1"] } }
            })],
            &[],
        );
        match TotpAtRest::from_config(&cfg) {
            Err(TotpAtRestError::InvalidConfig(reason)) => {
                assert!(reason.contains("Auth:TotpKeyRing"), "reason: {reason}");
            }
            other => panic!("ожидался InvalidConfig, получено {other:?}"),
        }
    }

    #[test]
    fn from_config_key_of_wrong_length_is_config_error() {
        let short = STANDARD.encode([1_u8; 16]);
        let cfg = FloraConfig::from_layers(
            "Production",
            &[serde_json::json!({
                "Auth": {
                    "TotpKeyRing": {
                        "ActiveKeyId": "t1",
                        "KeyIds": ["t1"],
                        "Key": { "t1": short }
                    }
                }
            })],
            &[],
        );
        assert!(matches!(
            TotpAtRest::from_config(&cfg),
            Err(TotpAtRestError::InvalidConfig(_))
        ));
    }

    #[test]
    fn debug_does_not_leak_key_material() {
        let at_rest = sealed(ring_with(&[("k1", 7)]), "k1");
        let rendered = format!("{at_rest:?}");
        assert!(rendered.contains("redacted"));
        assert_eq!(format!("{:?}", TotpAtRest::plain()), "TotpAtRest::Plain");
    }
}
