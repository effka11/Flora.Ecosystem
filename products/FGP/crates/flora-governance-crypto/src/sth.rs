//! Signed tree head журнала и витнесс-косайнинг (FGP-CRYPTO §8, FGP §6.4).
//!
//! CT-класс: оператор периодически публикует STH — подписанный снапшот
//! `(tree_size, root, timestamp)`; независимые витнессы реплицируют журнал,
//! проверяют consistency от предыдущего head и косайнят тот же снапшот.
//! Клиент принимает журнал только с **≥ [`MIN_WITNESS_COSIGNS`] валидными
//! косайнами** от различных витнессов реестра (FGP Приложение A): показать двум
//! клиентам две разные истории (split-view) значит расколоть и витнессов, а их
//! подписи публичны и сравнимы — расхождение само является криптографическим
//! доказательством события уровня 3 (THREATS §6.2).
//!
//! P0-формат косайнов — множество Ed25519-подписей (FGP-CRYPTO §8: «FROST-агрегат
//! или множество Ed25519 — формат в векторах»); FROST приходит с P1. Канонические
//! байты и подписи бит-в-бит зафиксированы вектором `governance-log-sth-v1.json`
//! (+ негативы отдельным файлом). Реестр витнессов и политика ротации — уровень
//! модуля/governance (R2), здесь — только криптография.

use crate::ds;
use crate::merkle::Hash;
use crate::sig::{self, PublicKey, SignatureBytes};

/// Минимум валидных витнесс-косайнов, с которым клиент принимает журнал
/// (FGP §6.4, Приложение A; ниже трёх активных витнессов — freeze binding).
pub const MIN_WITNESS_COSIGNS: usize = 3;

/// Head журнала прозрачности на момент публикации.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct TreeHead {
    /// Число листьев журнала.
    pub tree_size: u64,
    /// Merkle-корень префикса этого размера ([`crate::merkle::root`]).
    pub root: Hash,
    /// Момент публикации, Unix-миллисекунды (UTC). Поле информационное:
    /// клиенты сверяют свежесть, консенсуса по времени протокол не требует.
    pub timestamp_ms: u64,
}

impl TreeHead {
    /// Канонические байты подписи: `tree_size LE64 ‖ root ‖ timestamp_ms LE64`
    /// (48 байт). Формат нормативен и зафиксирован вектором.
    pub fn signing_bytes(&self) -> [u8; 48] {
        let mut bytes = [0u8; 48];
        bytes[..8].copy_from_slice(&self.tree_size.to_le_bytes());
        bytes[8..40].copy_from_slice(&self.root);
        bytes[40..].copy_from_slice(&self.timestamp_ms.to_le_bytes());
        bytes
    }
}

/// Косайн: подпись (оператора или витнесса) над каноническими байтами head
/// с меткой [`ds::LOG_STH`]. Самодостаточен для проверки третьей стороной.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Cosign {
    /// Ed25519-ключ подписавшего (принадлежность реестру проверяет клиент).
    pub signer: PublicKey,
    /// Подпись `LOG_STH ‖ signing_bytes(head)`.
    pub signature: SignatureBytes,
}

/// Подписать head (оператор при публикации STH, витнесс при косайнинге).
pub fn sign_tree_head(head: &TreeHead, secret_seed: &[u8; 32]) -> Cosign {
    Cosign {
        signer: sig::public_key(secret_seed),
        signature: sig::sign(ds::LOG_STH, &head.signing_bytes(), secret_seed),
    }
}

/// Проверить одну подпись head против заявленного ключа.
pub fn verify_tree_head(head: &TreeHead, cosign: &Cosign) -> bool {
    sig::verify(
        ds::LOG_STH,
        &head.signing_bytes(),
        &cosign.signature,
        &cosign.signer,
    )
}

/// Число валидных косайнов head от **различных** витнессов реестра.
///
/// Не зачитываются: подписи ключей вне `witness_registry`, невалидные подписи,
/// повторные косайны одного и того же витнесса (считается один).
pub fn count_valid_cosigns(
    head: &TreeHead,
    cosigns: &[Cosign],
    witness_registry: &[PublicKey],
) -> usize {
    let mut counted: Vec<&PublicKey> = Vec::new();
    for cosign in cosigns {
        if !witness_registry.contains(&cosign.signer) {
            continue;
        }
        if counted.contains(&&cosign.signer) {
            continue;
        }
        if verify_tree_head(head, cosign) {
            counted.push(&cosign.signer);
        }
    }
    counted.len()
}

/// Клиентское правило приёма журнала: валидных косайнов ≥ `min_cosigns`
/// (нормативный минимум — [`MIN_WITNESS_COSIGNS`]).
pub fn accept_tree_head(
    head: &TreeHead,
    cosigns: &[Cosign],
    witness_registry: &[PublicKey],
    min_cosigns: usize,
) -> bool {
    count_valid_cosigns(head, cosigns, witness_registry) >= min_cosigns
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::merkle;

    fn witness_seed(i: u8) -> [u8; 32] {
        [0x50 + i; 32]
    }

    fn head() -> TreeHead {
        TreeHead {
            tree_size: 13,
            root: merkle::leaf_hash(b"synthetic-root"),
            timestamp_ms: 1_780_000_000_000,
        }
    }

    fn registry(n: u8) -> Vec<PublicKey> {
        (0..n).map(|i| sig::public_key(&witness_seed(i))).collect()
    }

    #[test]
    fn signing_bytes_layout_is_canonical() {
        let h = head();
        let bytes = h.signing_bytes();
        assert_eq!(&bytes[..8], &13u64.to_le_bytes());
        assert_eq!(&bytes[8..40], &h.root);
        assert_eq!(&bytes[40..], &1_780_000_000_000u64.to_le_bytes());
    }

    #[test]
    fn sign_verify_roundtrip() {
        let h = head();
        let cosign = sign_tree_head(&h, &witness_seed(0));
        assert!(verify_tree_head(&h, &cosign));
    }

    #[test]
    fn tampered_head_fails() {
        let h = head();
        let cosign = sign_tree_head(&h, &witness_seed(0));
        let mut forked = h;
        forked.root = merkle::leaf_hash(b"rewritten");
        assert!(!verify_tree_head(&forked, &cosign));
        let mut grown = h;
        grown.tree_size += 1;
        assert!(!verify_tree_head(&grown, &cosign));
    }

    #[test]
    fn accept_requires_three_distinct_registry_witnesses() {
        let h = head();
        let reg = registry(5);
        let cosigns: Vec<Cosign> = (0..3)
            .map(|i| sign_tree_head(&h, &witness_seed(i)))
            .collect();
        assert!(accept_tree_head(&h, &cosigns, &reg, MIN_WITNESS_COSIGNS));
        // Двух не хватает.
        assert!(!accept_tree_head(
            &h,
            &cosigns[..2],
            &reg,
            MIN_WITNESS_COSIGNS
        ));
    }

    #[test]
    fn duplicate_witness_counts_once() {
        let h = head();
        let reg = registry(5);
        let one = sign_tree_head(&h, &witness_seed(0));
        let cosigns = [one, one, one, sign_tree_head(&h, &witness_seed(1))];
        assert_eq!(count_valid_cosigns(&h, &cosigns, &reg), 2);
    }

    #[test]
    fn unknown_witness_does_not_count() {
        let h = head();
        let reg = registry(2); // витнессы 0 и 1
        let cosigns = [
            sign_tree_head(&h, &witness_seed(0)),
            sign_tree_head(&h, &witness_seed(7)), // вне реестра
        ];
        assert_eq!(count_valid_cosigns(&h, &cosigns, &reg), 1);
    }

    #[test]
    fn invalid_signature_does_not_count() {
        let h = head();
        let reg = registry(3);
        let mut bad = sign_tree_head(&h, &witness_seed(0));
        bad.signature[0] ^= 1;
        assert_eq!(count_valid_cosigns(&h, &[bad], &reg), 0);
    }

    #[test]
    fn cosign_for_other_head_does_not_count() {
        let h = head();
        let reg = registry(3);
        let mut other = h;
        other.tree_size = 14;
        let stale = sign_tree_head(&other, &witness_seed(0));
        assert_eq!(count_valid_cosigns(&h, &[stale], &reg), 0);
    }
}
