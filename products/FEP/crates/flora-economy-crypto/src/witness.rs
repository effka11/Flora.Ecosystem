//! Витнесс-косайнинг head журнала (FEP.md §9.3, аналог Signed Tree Head CT / FGP §6.4).
//!
//! Витнесс — независимый наблюдатель: он реплеит журнал (или хотя бы проверяет
//! consistency-доказательства между head'ами) и подписывает увиденный [`LedgerHead`].
//! Набор косайнов от независимых витнессов делает **скрытый форк** журнала обнаружимым:
//! секвенсор не может показать двум клиентам две разные истории, не расколов и витнессов
//! (а их подписи публичны и сравнимы).
//!
//! Ядро даёт только детерминированные примитивы: канонические байты head подписываются
//! Ed25519 с доменной меткой [`crate::domain::LEDGER_STH`]. Реестр витнессов, приём и
//! хранение косайнов — уровень модуля (`flora-economy`); политика кворума — уровень
//! governance (FGP, класс R2).

use serde::{Deserialize, Serialize};

use crate::domain;
use crate::error::EconomyError;
use crate::ledger::LedgerHead;
use crate::sig::{PublicKeyBytes, SignatureBytes, public_key, sign, verify};

/// Косайн: подпись витнесса над каноническими байтами head.
///
/// Самодостаточен для проверки третьей стороной: содержит и head, и ключ, и подпись.
/// Пара `(witness, head.size)` естественно идемпотентна — повторный косайн того же
/// размера тем же витнессом ничего не добавляет.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadCosign {
    /// Head, который витнесс видел и подписал.
    pub head: LedgerHead,
    /// Ed25519-ключ витнесса (реестр ключей — губернативный параметр модуля).
    #[serde(with = "crate::hexser")]
    pub witness: PublicKeyBytes,
    /// Подпись `LEDGER_STH ‖ head.canonical_bytes()`.
    #[serde(with = "crate::hexser")]
    pub signature: SignatureBytes,
}

/// Подписать head ключом витнесса (для витнесс-демонов и тестов).
pub fn cosign_head(head: &LedgerHead, witness_seed: &[u8; 32]) -> HeadCosign {
    HeadCosign {
        head: head.clone(),
        witness: public_key(witness_seed),
        signature: sign(domain::LEDGER_STH, &head.canonical_bytes(), witness_seed),
    }
}

/// Проверить косайн: подпись действительна для заявленного ключа над заявленным head.
///
/// Принадлежность ключа реестру витнессов и совпадение head с реальной историей журнала
/// проверяет вызывающая сторона — здесь только криптография.
pub fn verify_head_cosign(cosign: &HeadCosign) -> Result<(), EconomyError> {
    verify(
        domain::LEDGER_STH,
        &cosign.head.canonical_bytes(),
        &cosign.signature,
        &cosign.witness,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::amount::Timestamp;

    const WITNESS_SEED: [u8; 32] = [77u8; 32];

    fn head() -> LedgerHead {
        LedgerHead {
            size: 42,
            last_entry_hash: [1u8; 32],
            merkle_root: [2u8; 32],
            at: Timestamp(1_700_000_000_000),
        }
    }

    #[test]
    fn cosign_roundtrip() {
        let cosign = cosign_head(&head(), &WITNESS_SEED);
        assert!(verify_head_cosign(&cosign).is_ok());
    }

    #[test]
    fn tampered_head_fails() {
        let mut cosign = cosign_head(&head(), &WITNESS_SEED);
        cosign.head.size += 1;
        assert!(verify_head_cosign(&cosign).is_err());
    }

    #[test]
    fn tampered_root_fails() {
        let mut cosign = cosign_head(&head(), &WITNESS_SEED);
        cosign.head.merkle_root = [9u8; 32];
        assert!(verify_head_cosign(&cosign).is_err());
    }

    #[test]
    fn wrong_witness_key_fails() {
        let mut cosign = cosign_head(&head(), &WITNESS_SEED);
        cosign.witness = public_key(&[88u8; 32]);
        assert!(verify_head_cosign(&cosign).is_err());
    }

    #[test]
    fn json_shape_is_stable() {
        let cosign = cosign_head(&head(), &WITNESS_SEED);
        let json = serde_json::to_string(&cosign).unwrap();
        assert!(json.contains("\"head\""));
        assert!(json.contains("\"witness\""));
        assert!(json.contains("\"signature\""));
        let back: HeadCosign = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cosign);
    }
}
