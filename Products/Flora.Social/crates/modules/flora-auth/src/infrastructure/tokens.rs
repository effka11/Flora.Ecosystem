//! Генерация session-секретов — паритет `JwtTokenService` (refresh 64 B, csrf 32 B, hmac 64 B).

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use getrandom::fill;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const REFRESH_HASH_PREFIX: &str = "sha256:";
const REFRESH_FAMILY_DOMAIN: &[u8] = b"flora-refresh-family-v1\0";
type HmacSha256 = Hmac<Sha256>;

/// `FloraUuid.NewGuid().ToString("N")` — 32 hex без дефисов.
pub fn generate_jwt_id() -> String {
    Uuid::now_v7().simple().to_string()
}

pub fn generate_refresh_token(session_id: Uuid, signing_key: &[u8]) -> String {
    let payload = format!("{session_id}.{}", STANDARD.encode(random_bytes(64)));
    let signature = refresh_family_signature(&payload, signing_key);
    format!("{payload}.{}", URL_SAFE_NO_PAD.encode(signature))
}

/// Возвращает family-id только для токена, выпущенного сервером. HMAC не даёт
/// превратить открытый UUID сессии в unauthenticated session-revocation oracle.
pub fn refresh_token_session_id(token: &str, signing_key: &[u8]) -> Option<Uuid> {
    let (payload, signature) = token.rsplit_once('.')?;
    let signature = URL_SAFE_NO_PAD.decode(signature).ok()?;
    let mut mac = HmacSha256::new_from_slice(signing_key).ok()?;
    mac.update(REFRESH_FAMILY_DOMAIN);
    mac.update(payload.as_bytes());
    mac.verify_slice(&signature).ok()?;

    let (session_id, secret) = payload.split_once('.')?;
    let session_id = Uuid::parse_str(session_id).ok()?;
    let decoded = STANDARD.decode(secret).ok()?;
    (decoded.len() == 64).then_some(session_id)
}

fn refresh_family_signature(payload: &str, signing_key: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(signing_key).expect("HMAC accepts any key length");
    mac.update(REFRESH_FAMILY_DOMAIN);
    mac.update(payload.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// Одностороннее представление refresh token для БД. Сам токен имеет 512 бит
/// энтропии, поэтому SHA-256 без соли не допускает практического перебора.
pub fn hash_refresh_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    format!("{REFRESH_HASH_PREFIX}{}", URL_SAFE_NO_PAD.encode(digest))
}

pub fn generate_csrf_token() -> String {
    STANDARD.encode(random_bytes(32))
}

pub fn generate_hmac_key() -> String {
    STANDARD.encode(random_bytes(64))
}

fn random_bytes(len: usize) -> Vec<u8> {
    let mut buf = vec![0u8; len];
    fill(&mut buf).expect("OS CSPRNG");
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_SIGNING_KEY: &[u8] = b"unit-test-refresh-signing-key";

    #[test]
    fn jwt_id_is_32_hex() {
        let id = generate_jwt_id();
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!id.contains('-'));
    }

    #[test]
    fn refresh_token_carries_session_id_and_64_random_bytes() {
        let session_id = Uuid::now_v7();
        let t = generate_refresh_token(session_id, TEST_SIGNING_KEY);
        assert_eq!(
            refresh_token_session_id(&t, TEST_SIGNING_KEY),
            Some(session_id)
        );
        let (_, remainder) = t.split_once('.').unwrap();
        let (secret, _) = remainder.split_once('.').unwrap();
        let decoded = STANDARD.decode(secret).expect("base64");
        assert_eq!(decoded.len(), 64);
    }

    #[test]
    fn refresh_family_id_rejects_forged_or_wrongly_signed_tokens() {
        let session_id = Uuid::now_v7();
        let token = generate_refresh_token(session_id, TEST_SIGNING_KEY);
        assert_eq!(refresh_token_session_id(&token, b"different-key"), None);

        let (_, signature) = token.rsplit_once('.').unwrap();
        let forged = format!("{session_id}.{}.{signature}", STANDARD.encode([0_u8; 64]));
        assert_eq!(refresh_token_session_id(&forged, TEST_SIGNING_KEY), None);
    }

    #[test]
    fn refresh_hash_is_one_way_tagged_and_fixed_length() {
        let token = generate_refresh_token(Uuid::now_v7(), TEST_SIGNING_KEY);
        let hash = hash_refresh_token(&token);
        assert!(hash.starts_with(REFRESH_HASH_PREFIX));
        assert_eq!(hash.len(), REFRESH_HASH_PREFIX.len() + 43);
        assert_ne!(hash, token);
        assert_eq!(hash_refresh_token(&token), hash);
    }
}
