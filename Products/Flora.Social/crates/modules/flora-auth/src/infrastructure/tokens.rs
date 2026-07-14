//! Генерация session-секретов — паритет `JwtTokenService` (refresh 64 B, csrf 32 B, hmac 64 B).

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use getrandom::fill;
use uuid::Uuid;

/// `FloraUuid.NewGuid().ToString("N")` — 32 hex без дефисов.
pub fn generate_jwt_id() -> String {
    Uuid::now_v7().simple().to_string()
}

pub fn generate_refresh_token() -> String {
    STANDARD.encode(random_bytes(64))
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

    #[test]
    fn jwt_id_is_32_hex() {
        let id = generate_jwt_id();
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!id.contains('-'));
    }

    #[test]
    fn refresh_token_is_standard_base64_of_64_bytes() {
        let t = generate_refresh_token();
        let decoded = STANDARD.decode(&t).expect("base64");
        assert_eq!(decoded.len(), 64);
    }
}
