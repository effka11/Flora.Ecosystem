//! SHA-256 хелперы и хеш-цепочка журнала.
//!
//! Выбор SHA-256 (crate `sha2`, RustCrypto, чистый Rust, без C-зависимостей, wasm-совместим)
//! согласован с остальным стеком Flora (FSCP тоже на SHA-256). Хеш-структуры пост-квантово
//! стойки (FGP-CRYPTO §11). Все хеши — над доменно-тегированным входом ([`crate::domain`]).

use sha2::{Digest, Sha256};

/// 32-байтовый дайджест.
pub type Hash32 = [u8; 32];

/// Нулевой хеш (родитель genesis-записи).
pub const ZERO_HASH: Hash32 = [0u8; 32];

/// SHA-256 от `label ‖ data`, где длина метки и данных зафиксирована доменным префиксом.
pub fn tagged(label: &str, data: &[u8]) -> Hash32 {
    let mut hasher = Sha256::new();
    hasher.update(label.as_bytes());
    hasher.update(data);
    hasher.finalize().into()
}

/// SHA-256 от конкатенации нескольких кусков с доменной меткой.
pub fn tagged_parts(label: &str, parts: &[&[u8]]) -> Hash32 {
    let mut hasher = Sha256::new();
    hasher.update(label.as_bytes());
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

/// Hex-представление хеша (lowercase) — для JSON test vectors и логов.
pub fn to_hex(hash: &Hash32) -> String {
    let mut s = String::with_capacity(64);
    for byte in hash {
        s.push(char::from_digit((byte >> 4) as u32, 16).unwrap());
        s.push(char::from_digit((byte & 0x0f) as u32, 16).unwrap());
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tagged_is_deterministic() {
        let a = tagged("flora/economy/v1/test", b"payload");
        let b = tagged("flora/economy/v1/test", b"payload");
        assert_eq!(a, b);
    }

    #[test]
    fn different_labels_differ() {
        let a = tagged("flora/economy/v1/a", b"x");
        let b = tagged("flora/economy/v1/b", b"x");
        assert_ne!(a, b);
    }

    #[test]
    fn tagged_parts_equals_concatenation() {
        let joined = tagged("flora/economy/v1/t", b"hello world");
        let split = tagged_parts("flora/economy/v1/t", &[b"hello", b" world"]);
        assert_eq!(joined, split);
    }

    #[test]
    fn hex_is_64_chars() {
        let h = tagged("flora/economy/v1/t", b"x");
        assert_eq!(to_hex(&h).len(), 64);
    }
}
