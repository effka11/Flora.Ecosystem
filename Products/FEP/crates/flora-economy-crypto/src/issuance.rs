//! Эмиссия LIV: Proof-of-Personhood UBI — «деньги существования».
//!
//! Пост-дефицитный принцип: новые деньги появляются **по числу живых людей**, а не по капиталу
//! (PoS), не по сожжённой энергии (PoW) и не по решению эмитента. Каждый человек уровня V1+
//! (FPP §2) получает равный поток LIV за эпоху. Это единственный источник эмиссии.
//!
//! Следствия конструкции:
//! - богатство не самовоспроизводится: у эмиссии нет прото-капитала, «премайна» и учредительских
//!   аллокаций — genesis-запись журнала создаёт ноль grain;
//! - в паре с демерреджем денежная масса на человека сходится к конечному пределу
//!   `UBI_epoch / (1 - retention_epoch)` — эмиссия не гиперинфляционна, а стационарна;
//! - Sybil-защита эмиссии — это FPP: цена подделки личности `C_identity(V1)` публично замеряется;
//!   эмиссия на фальшивую личность окупается только если `C_identity < UBI·T`, что делает
//!   `C_identity` одновременно и экономическим параметром безопасности (FGP §4.1.1).
//!
//! Ядро не знает про Verification: кто «активный V1+» — решает вызывающая сторона (модуль
//! `flora-economy` спрашивает `flora-verification-contracts`); здесь — только арифметика и правило
//! «одна эпоха — одно начисление».

use crate::amount::{Grains, Timestamp};
use crate::params::Parameters;

/// Номер UBI-эпохи для метки времени (эпоха 0 начинается в `genesis_at`).
pub fn epoch_index(genesis_at: Timestamp, now: Timestamp, epoch_ms: i64) -> u64 {
    if epoch_ms <= 0 {
        return 0;
    }
    (now.saturating_ms_since(genesis_at) / epoch_ms) as u64
}

/// Сколько эпох задолжало начисление: от `last_claimed_epoch` (не включая) до `current_epoch`
/// (включая). `None` — начислять нечего.
///
/// Начисление ретроактивно ограничено `max_backfill` эпохами: вернувшийся после долгого отсутствия
/// получает хвост, но не бесконечный (мёртвые души не копят UBI годами — рифма с вымыванием
/// электората FPP §2).
pub fn claimable_epochs(
    last_claimed_epoch: Option<u64>,
    current_epoch: u64,
    max_backfill: u64,
) -> Option<(u64, u64)> {
    let from = match last_claimed_epoch {
        Some(last) if last >= current_epoch => return None,
        Some(last) => last + 1,
        None => 0,
    };
    let from = from.max(current_epoch.saturating_sub(max_backfill.saturating_sub(1)));
    Some((from, current_epoch))
}

/// Сумма UBI за диапазон эпох `[from, to]` включительно.
pub fn ubi_amount(from_epoch: u64, to_epoch: u64, params: &Parameters) -> Grains {
    debug_assert!(from_epoch <= to_epoch);
    let epochs = to_epoch - from_epoch + 1;
    Grains(params.ubi_per_epoch.0.saturating_mul(epochs as i64))
}

/// Теоретический предел денежной массы на человека при бессрочном UBI + демерредже:
/// `UBI_epoch / (1 - retention_epoch)`, где `retention_epoch = (1-δ)^(periods_per_epoch)`.
/// Диагностическая функция (для документации/дашбордов, не consensus-путь).
pub fn steady_state_per_person(params: &Parameters) -> Grains {
    let periods_per_epoch = (params.ubi_epoch_ms / params.demurrage_period_ms).max(1) as u64;
    let retention_epoch = params.retention_per_period().pow(periods_per_epoch);
    let one_minus = crate::fixed::Fixed(crate::fixed::ONE_RAW - retention_epoch.0);
    if one_minus.0 <= 0 {
        return Grains(i64::MAX);
    }
    // ubi / (1 - r) = ubi * 2^32 / raw(1-r), считаем в i128 с насыщением.
    let numerator = (params.ubi_per_epoch.0 as i128) << crate::fixed::FRAC_BITS;
    Grains(crate::fixed::saturate_i128(
        crate::fixed::div_round_half_even(numerator, one_minus.0 as i128),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::amount::LIV_IN_GRAINS;

    #[test]
    fn epoch_index_basics() {
        let genesis = Timestamp(0);
        let epoch_ms = 100;
        assert_eq!(epoch_index(genesis, Timestamp(0), epoch_ms), 0);
        assert_eq!(epoch_index(genesis, Timestamp(99), epoch_ms), 0);
        assert_eq!(epoch_index(genesis, Timestamp(100), epoch_ms), 1);
        assert_eq!(epoch_index(genesis, Timestamp(1050), epoch_ms), 10);
    }

    #[test]
    fn first_claim_is_current_epoch_only_window() {
        // Новый участник с max_backfill=1: получает только текущую эпоху.
        assert_eq!(claimable_epochs(None, 5, 1), Some((5, 5)));
    }

    #[test]
    fn no_double_claim() {
        assert_eq!(claimable_epochs(Some(5), 5, 12), None);
        assert_eq!(claimable_epochs(Some(6), 5, 12), None);
    }

    #[test]
    fn backfill_is_bounded() {
        // Пропустил 100 эпох, backfill 3 → получает эпохи 98..=100.
        assert_eq!(claimable_epochs(Some(0), 100, 3), Some((98, 100)));
        // Пропустил 2 эпохи, backfill 12 → получает всё пропущенное.
        assert_eq!(claimable_epochs(Some(7), 9, 12), Some((8, 9)));
    }

    #[test]
    fn ubi_amount_is_linear_in_epochs() {
        let p = Parameters::genesis();
        assert_eq!(ubi_amount(3, 3, &p), p.ubi_per_epoch);
        assert_eq!(ubi_amount(1, 3, &p).0, p.ubi_per_epoch.0 * 3);
    }

    #[test]
    fn steady_state_is_finite_and_reasonable() {
        let p = Parameters::genesis();
        let steady = steady_state_per_person(&p);
        // 1000 liv/эпоху при ~0.57 % распада за 30-дневную эпоху → предел ~175k liv.
        let liv = steady.0 / LIV_IN_GRAINS;
        assert!(
            liv > 100_000 && liv < 300_000,
            "steady = {liv} liv"
        );
    }
}
