//! Argon2id — паритет `Argon2PasswordHasher.cs` / `docs/test-vectors/backend-parity/argon2id-v1.json`.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use subtle::ConstantTimeEq;

const SALT_LEN: usize = 16;
const HASH_LEN: usize = 32;
const ITERATIONS: u32 = 4;
const MEMORY_KIB: u32 = 65536;
const PARALLELISM: u32 = 2;

/// Hash password → Base64(salt16‖hash32).
pub fn hash_password(password: &str) -> String {
    let mut salt = [0u8; SALT_LEN];
    getrandom::fill(&mut salt).expect("OS CSPRNG");
    let params = Params::new(MEMORY_KIB, ITERATIONS, PARALLELISM, Some(HASH_LEN)).expect("params");
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut hash = [0u8; HASH_LEN];
    argon2
        .hash_password_into(password.as_bytes(), &salt, &mut hash)
        .expect("argon2 hash");
    let mut combined = Vec::with_capacity(SALT_LEN + HASH_LEN);
    combined.extend_from_slice(&salt);
    combined.extend_from_slice(&hash);
    STANDARD.encode(combined)
}

/// Verify Base64(salt16‖hash32). Constant-time compare; malformed → false.
pub fn verify_password(password: &str, stored_hash: &str) -> bool {
    let Ok(combined) = STANDARD.decode(stored_hash) else {
        return false;
    };
    if combined.len() != SALT_LEN + HASH_LEN {
        return false;
    }
    let (salt, expected) = combined.split_at(SALT_LEN);

    let Ok(params) = Params::new(MEMORY_KIB, ITERATIONS, PARALLELISM, Some(HASH_LEN)) else {
        return false;
    };
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut computed = [0u8; HASH_LEN];
    if argon2
        .hash_password_into(password.as_bytes(), salt, &mut computed)
        .is_err()
    {
        return false;
    }
    bool::from(computed.ct_eq(expected))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_hash_verify() {
        let h = hash_password("secret-pass");
        assert!(verify_password("secret-pass", &h));
        assert!(!verify_password("other", &h));
    }

    #[test]
    fn golden_vector_case_verifies() {
        // docs/test-vectors/backend-parity/argon2id-v1.json case[1] (ASCII-friendly)
        let password = "простой-пароль-123";
        let stored = "8OHSw7Sllod4aVpLPC0eD0W2OWZGOzFd9mmPwRicJvM8XHz2Y/DIKgTVA6aqL/Hc";
        assert!(verify_password(password, stored));
        assert!(!verify_password("wrong", stored));
    }
}
