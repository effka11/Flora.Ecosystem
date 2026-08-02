//! Публичные жеребьёвки и общая случайность (FGP-CRYPTO §6; профиль P0 — §14).
//!
//! P0-механика: детерминированная выборка из публичного реестра по сиду окна —
//! **пересчитываема любым**, VRF-ключей не требует. Используется для пар
//! liveness-церемоний, назначения аттесторов, порядка очередей, состава панелей
//! и жюри (по приватному пулу — с журналированием обоснования, §6). Приватные
//! самовыборки референдумов (ECVRF Algorand-класса) приходят с P1.
//!
//! Анти-grinding: сид собирается из head журнала на **заранее объявленный** момент
//! T (после закрытия деклараций/реестров) и внешнего якоря случайности той же
//! эпохи — манипуляция требует контроля обеих сторон одновременно (FGP-CRYPTO §6).
//! Выборка бит-в-бит зафиксирована вектором `governance-sortition-v1.json`.

use crate::ds;
use crate::merkle::Hash;

/// Сид окна: `derive(SORTITION_SEED, len(sth) LE64 ‖ sth ‖ anchor)`.
///
/// `sth_bytes` — канонические байты STH на момент T ([`crate::sth::TreeHead::signing_bytes`]),
/// `external_anchor` — внешний якорь (публичный маяк случайности / head стороннего
/// журнала). Длино-префикс первого поля исключает неоднозначность конкатенации.
pub fn window_seed(sth_bytes: &[u8], external_anchor: &[u8]) -> Hash {
    let mut material = Vec::with_capacity(8 + sth_bytes.len() + external_anchor.len());
    material.extend_from_slice(&(sth_bytes.len() as u64).to_le_bytes());
    material.extend_from_slice(sth_bytes);
    material.extend_from_slice(external_anchor);
    ds::derive(ds::SORTITION_SEED, &material)
}

/// Суб-сид контекста (страта, конкретная жеребьёвка внутри окна):
/// `derive(SORTITION_SEED, seed ‖ label)`. Разные контексты одного окна получают
/// независимые порядки — выборка панели не раскрывает выборку аттесторов.
pub fn context_seed(window_seed: &Hash, context_label: &[u8]) -> Hash {
    let mut material = Vec::with_capacity(32 + context_label.len());
    material.extend_from_slice(window_seed);
    material.extend_from_slice(context_label);
    ds::derive(ds::SORTITION_SEED, &material)
}

/// Ранг участника: `derive(SORTITION_RANK, seed ‖ member)`; сравнение лексикографическое.
///
/// `member` — 32-байтовый commitment из аттестационного набора (FGP-CRYPTO §2.2).
pub fn member_rank(seed: &Hash, member: &[u8; 32]) -> Hash {
    let mut material = [0u8; 64];
    material[..32].copy_from_slice(seed);
    material[32..].copy_from_slice(member);
    ds::derive(ds::SORTITION_RANK, &material)
}

/// Детерминированная выборка `k` участников из реестра: `k` наименьших по
/// `(rank, index)`. Возвращает **индексы** в реестре в порядке возрастания ранга —
/// тот же вызов с `k = len` даёт полную перестановку (порядок очереди).
///
/// Реестр — append-only набор commitments эпохи (владелец — Verification);
/// уникальность его элементов — инвариант владельца, не этой функции.
pub fn draw(seed: &Hash, members: &[[u8; 32]], k: usize) -> Vec<u32> {
    let mut ranked: Vec<(Hash, u32)> = members
        .iter()
        .enumerate()
        .map(|(i, m)| (member_rank(seed, m), i as u32))
        .collect();
    ranked.sort_unstable();
    ranked.truncate(k);
    ranked.into_iter().map(|(_, i)| i).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn members(n: usize) -> Vec<[u8; 32]> {
        (0..n)
            .map(|i| ds::derive(ds::CIVIC_COMMIT, format!("member-{i}").as_bytes()))
            .collect()
    }

    fn seed() -> Hash {
        window_seed(b"sth-bytes", b"anchor")
    }

    #[test]
    fn seed_depends_on_both_sources_and_length_prefix() {
        let base = window_seed(b"sth", b"anchor");
        assert_ne!(base, window_seed(b"sth2", b"anchor"));
        assert_ne!(base, window_seed(b"sth", b"anchor2"));
        // Перенос байта через границу полей меняет сид (длино-префикс).
        assert_ne!(window_seed(b"ab", b"c"), window_seed(b"a", b"bc"));
    }

    #[test]
    fn context_seeds_are_independent() {
        let w = seed();
        assert_ne!(context_seed(&w, b"panel"), context_seed(&w, b"attestors"));
        assert_ne!(context_seed(&w, b"panel"), w);
    }

    #[test]
    fn draw_is_deterministic_and_bounded() {
        let m = members(50);
        let a = draw(&seed(), &m, 9);
        let b = draw(&seed(), &m, 9);
        assert_eq!(a, b);
        assert_eq!(a.len(), 9);
        // Все индексы различны и в диапазоне.
        let mut sorted = a.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), 9);
        assert!(sorted.iter().all(|&i| (i as usize) < 50));
    }

    #[test]
    fn draw_prefix_property() {
        // Выборка k — префикс выборки k+1: ранги не зависят от k.
        let m = members(30);
        let s = seed();
        let five = draw(&s, &m, 5);
        let six = draw(&s, &m, 6);
        assert_eq!(five[..], six[..5]);
    }

    #[test]
    fn full_draw_is_permutation() {
        let m = members(17);
        let order = draw(&seed(), &m, 17);
        let mut sorted = order.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, (0..17).collect::<Vec<u32>>());
    }

    #[test]
    fn different_seeds_give_different_orders() {
        let m = members(40);
        let a = draw(&window_seed(b"sth", b"anchor-1"), &m, 40);
        let b = draw(&window_seed(b"sth", b"anchor-2"), &m, 40);
        assert_ne!(a, b);
    }

    #[test]
    fn oversized_k_returns_everyone() {
        let m = members(3);
        assert_eq!(draw(&seed(), &m, 10).len(), 3);
        assert!(draw(&seed(), &[], 5).is_empty());
    }
}
