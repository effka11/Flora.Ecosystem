//! Commit-reveal скрытых агрегатов (FGP §3.4; профиль P0 — FGP-CRYPTO §14).
//!
//! Делиберация не показывает промежуточные счётчики: участник публикует
//! commitment `derive(COMMIT_REVEAL, nonce ‖ payload)`, раскрытие — батчем после
//! закрытия окна; до раскрытия commitment не говорит ничего (hiding — 256-битный
//! nonce), после — не может быть переигран (binding — BLAKE3). Анонимности P0
//! **не даёт**: подачи идут под псевдонимами сервера, это доверие признано в §14;
//! криптографическая несвязываемость масок приходит с P1 (токены) / P2 (ZK).
//!
//! Nonce генерирует сторона commit'а (в ядре нет RNG — чистый wasm32); commitments
//! журналируются листьями (§8), так что тихая подмена ловится inclusion-пруфом.
//! Байты зафиксированы вектором `governance-commit-reveal-v1.json`.

use crate::ds;
use crate::merkle::Hash;

/// Commitment: `derive(COMMIT_REVEAL, nonce ‖ payload)`.
///
/// `payload` — канонические байты скрываемого артефакта (узел, ставка, оценка);
/// каноничность формата — забота владельца артефакта.
pub fn commit(nonce: &[u8; 32], payload: &[u8]) -> Hash {
    let mut material = Vec::with_capacity(32 + payload.len());
    material.extend_from_slice(nonce);
    material.extend_from_slice(payload);
    ds::derive(ds::COMMIT_REVEAL, &material)
}

/// Проверка раскрытия: пересчёт commitment и сравнение.
///
/// Значения публичны к моменту reveal — постоянное время сравнения не требуется.
pub fn verify_reveal(commitment: &Hash, nonce: &[u8; 32], payload: &[u8]) -> bool {
    commit(nonce, payload) == *commitment
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE: [u8; 32] = [0xA5; 32];

    #[test]
    fn reveal_roundtrip() {
        let c = commit(&NONCE, b"vote:for");
        assert!(verify_reveal(&c, &NONCE, b"vote:for"));
    }

    #[test]
    fn wrong_payload_fails() {
        let c = commit(&NONCE, b"vote:for");
        assert!(!verify_reveal(&c, &NONCE, b"vote:against"));
    }

    #[test]
    fn wrong_nonce_fails() {
        let c = commit(&NONCE, b"vote:for");
        assert!(!verify_reveal(&c, &[0x5A; 32], b"vote:for"));
    }

    #[test]
    fn nonce_boundary_is_fixed() {
        // Первые 32 байта — всегда nonce: сдвиг границы меняет commitment.
        let mut nonce2 = NONCE;
        nonce2[31] = b'v';
        assert_ne!(commit(&NONCE, b"vote"), commit(&nonce2, b"ote"));
    }

    #[test]
    fn commitment_hides_only_with_nonce() {
        // Одинаковый payload с разными nonce — разные commitments (unlinkability подач).
        assert_ne!(commit(&NONCE, b"same"), commit(&[1; 32], b"same"));
    }
}
