//! Реестр доменных меток и BLAKE3-деривации (FGP-CRYPTO §1.1, §2).
//!
//! Каждая подпись/хеш/PRF протокола — над сообщением с меткой `flora/<область>/v1/<операция>`;
//! коллизия меток = инцидент V-11. Этот модуль — **нормативный полный реестр**
//! (FGP-CRYPTO §1.1: «полный реестр живёт в `flora-governance-crypto` и в test vectors»).
//! Байтовое представление меток и выходы дериваций зафиксированы вектором
//! `governance-ds-tags-v1.json` (правило FSCP «байт-в-байт»).
//!
//! Единый примитив дериваций — BLAKE3 в режиме `derive_key` (контекст = метка):
//! доменное разделение встроено в примитив, а не имитируется префиксом сообщения.

/// Подпись гражданским ключом.
pub const CIVIC_SIGN: &str = "flora/civic/v1/sign";
/// Personhood-commitment (P1: BLAKE3 от `pk_civic || salt_dev`).
pub const CIVIC_COMMIT: &str = "flora/civic/v1/commit";
/// Стабильный публичный тег `civic_id` из commitment (FPP §10.0).
pub const CIVIC_ID: &str = "flora/civic/v1/id";
/// Nullifier-ключ `nk` из `sk_civic` (FGP-CRYPTO §2).
pub const NULLIFIER_NK: &str = "flora/nullifier/v1/nk";
/// Контекстный nullifier (P2: Poseidon2 в циркуите; метка — для P1-токенов).
pub const NULLIFIER_CTX: &str = "flora/nullifier/v1/ctx";
/// Регистрация делиберативной маски.
pub const MASK_REGISTER: &str = "flora/mask/v1/register";
/// Симуляционный ключ отрицаемости маски (designated-verifier).
pub const MASK_DV_SIM: &str = "flora/mask/v1/dv-sim";
/// VOPRF-токен гражданского кредита.
pub const TOKEN_CREDIT: &str = "flora/token/v1/credit";
/// Шифрование бюллетеня к ключу окна.
pub const BALLOT_ENCRYPT: &str = "flora/ballot/v1/encrypt";
/// Перезапись бюллетеня (coercion override).
pub const BALLOT_OVERWRITE: &str = "flora/ballot/v1/overwrite";
/// Частичная расшифровка тэлли (Chaum-Pedersen транскрипт).
pub const TALLY_PARTIAL_DEC: &str = "flora/tally/v1/partial-dec";
/// VRF публичной жеребьёвки (сортиция панелей и жюри).
pub const VRF_SORTITION: &str = "flora/vrf/v1/sortition";
/// VRF составления пар liveness-церемоний (FPP §3.1).
pub const VRF_CEREMONY_PAIR: &str = "flora/vrf/v1/ceremony-pair";
/// VRF назначения аттесторов документов (FPP §5.1).
pub const VRF_ATTESTOR_ASSIGN: &str = "flora/vrf/v1/attestor-assign";
/// ECVRF-самовыборка приватных выборок (FGP-CRYPTO §6).
pub const VRF_SELF_SELECT: &str = "flora/vrf/v1/self-select";
/// Лист журнала прозрачности.
pub const LOG_LEAF: &str = "flora/log/v1/leaf";
/// Внутренний узел Merkle-дерева журнала.
pub const LOG_NODE: &str = "flora/log/v1/node";
/// Signed tree head журнала.
pub const LOG_STH: &str = "flora/log/v1/sth";
/// Внешнее якорение STH.
pub const LOG_ANCHOR: &str = "flora/log/v1/anchor";
/// Threshold-OPRF дедупликации документов (FPP §5.1).
pub const OPRF_DOC_DEDUP: &str = "flora/oprf/v1/doc-dedup";
/// Записи леджера Commons-казны (FGP §10).
pub const TREASURY_LEDGER: &str = "flora/treasury/v1/ledger";
/// Эпохальный тег устройства (FPP-SIGNALS NS-D2; деривация — `fpp-crypto`).
pub const DEVICE_TAG: &str = "flora/device/v1/tag";

/// Полный реестр `(короткое имя, метка)` — источник для test vectors и аудита коллизий.
pub const REGISTRY: &[(&str, &str)] = &[
    ("civic/sign", CIVIC_SIGN),
    ("civic/commit", CIVIC_COMMIT),
    ("civic/id", CIVIC_ID),
    ("nullifier/nk", NULLIFIER_NK),
    ("nullifier/ctx", NULLIFIER_CTX),
    ("mask/register", MASK_REGISTER),
    ("mask/dv-sim", MASK_DV_SIM),
    ("token/credit", TOKEN_CREDIT),
    ("ballot/encrypt", BALLOT_ENCRYPT),
    ("ballot/overwrite", BALLOT_OVERWRITE),
    ("tally/partial-dec", TALLY_PARTIAL_DEC),
    ("vrf/sortition", VRF_SORTITION),
    ("vrf/ceremony-pair", VRF_CEREMONY_PAIR),
    ("vrf/attestor-assign", VRF_ATTESTOR_ASSIGN),
    ("vrf/self-select", VRF_SELF_SELECT),
    ("log/leaf", LOG_LEAF),
    ("log/node", LOG_NODE),
    ("log/sth", LOG_STH),
    ("log/anchor", LOG_ANCHOR),
    ("oprf/doc-dedup", OPRF_DOC_DEDUP),
    ("treasury/ledger", TREASURY_LEDGER),
    ("device/tag", DEVICE_TAG),
];

/// Доменно-разделённая деривация: BLAKE3 `derive_key(метка, материал)` → 32 байта.
pub fn derive(tag: &str, material: &[u8]) -> [u8; 32] {
    blake3::derive_key(tag, material)
}

/// `nk` — nullifier-ключ из гражданского секрета (FGP-CRYPTO §2).
///
/// Выполняется только на устройстве пользователя; вызывающий обязан
/// зачистить (`zeroize`) и вход, и выход после использования.
pub fn derive_nullifier_key(sk_civic: &[u8; 32]) -> [u8; 32] {
    derive(NULLIFIER_NK, sk_civic)
}

/// Personhood-commitment профиля P1: деривация от `pk_civic || salt_dev` (FGP-CRYPTO §2).
pub fn commitment_p1(pk_civic: &[u8; 32], salt_dev: &[u8; 32]) -> [u8; 32] {
    let mut material = [0u8; 64];
    material[..32].copy_from_slice(pk_civic);
    material[32..].copy_from_slice(salt_dev);
    derive(CIVIC_COMMIT, &material)
}

/// Стабильный публичный тег `civic_id` из commitment (FGP-CRYPTO §2, FPP §10.0).
pub fn civic_id(commitment: &[u8; 32]) -> [u8; 32] {
    derive(CIVIC_ID, commitment)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_has_no_collisions_and_canonical_prefix() {
        for (i, (name_a, tag_a)) in REGISTRY.iter().enumerate() {
            assert!(tag_a.starts_with("flora/"), "{name_a}: {tag_a}");
            assert!(tag_a.contains("/v1/"), "{name_a}: {tag_a}");
            for (name_b, tag_b) in &REGISTRY[i + 1..] {
                assert_ne!(tag_a, tag_b, "коллизия меток {name_a} / {name_b}");
                assert_ne!(name_a, name_b, "дубль имени {name_a}");
            }
        }
    }

    #[test]
    fn derive_is_domain_separated() {
        let material = [7u8; 32];
        assert_ne!(
            derive(CIVIC_SIGN, &material),
            derive(CIVIC_COMMIT, &material)
        );
        assert_ne!(derive(LOG_LEAF, b""), derive(LOG_NODE, b""));
    }

    #[test]
    fn civic_pipeline_is_deterministic() {
        let pk = [0x11u8; 32];
        let salt = [0x22u8; 32];
        let c1 = commitment_p1(&pk, &salt);
        let c2 = commitment_p1(&pk, &salt);
        assert_eq!(c1, c2);
        assert_ne!(civic_id(&c1), c1);
    }
}
