//! Аллокация битов по полосам (FRC-A.md, «Аллокация»).
//!
//! Reverse water-filling: β[b] = C + q[b] − 4·log2(width[b]), где C — общий
//! уровень, подобранный под бюджет. Это MMSE-оптимальное распределение
//! (равная дисторсия на коэффициент) в целых числах: вход — только квантованные
//! энергии и бюджет, поэтому энкодер и декодер получают идентичный результат
//! без передачи таблицы аллокации в битстриме.

use crate::bands::{NUM_BANDS, band_width};

/// Кап целевых бит на коэффициент: 64/8 = 8 бит.
pub(crate) const BETA_E8_MAX: i32 = 64;

/// Нормативная таблица `round(4·log2(width[b]))`.
pub(crate) const LOG2W_X4: [i32; NUM_BANDS] = [
    12, 12, 12, 12, 12, 12, 12, 12, 16, 16, 16, 16, 20, 20, 20, 22, 22, 24, 26, 29, 30,
];

/// Диапазон бинарного поиска C: при −3000 все β = 0 (|q| ≤ 1024, log2w ≤ 30),
/// при 3000 все β = 64.
const C_SEARCH: (i32, i32) = (-3000, 3000);

/// Полосы с энергией на уровне epsilon-пола энкодера (E ≈ 1e-10 → q ≈ −133)
/// не кодируются: цифровая тишина не должна тратить бюджет на нули формы.
/// Тот же порог гейтит anti-collapse (не вводить шум в цифровую тишину).
pub(crate) const Q_SILENCE_X4: i32 = -132;

/// Целевые биты на коэффициент в 1/8 бита, по плоскостям и полосам
/// (`planes * NUM_BANDS`, layout плоскость-мажорный, как у `q`).
pub(crate) fn compute_alloc(q: &[i32], planes: usize, shape_budget_bits: u64) -> Vec<u8> {
    debug_assert_eq!(q.len(), planes * NUM_BANDS);
    let s_e8 = shape_budget_bits as i64 * 8;
    // Полосы дешевле 1 бит/коэфф (β < 8) не кодируются: код Райса всё равно не
    // умеет дешевле 1 бита на символ. Вместе с λ ≤ 127 это гарантирует, что
    // форма всегда помещается в бюджет (при λ=127 все y=0 и стоят ровно
    // Σ width ≤ Σ β·width/8 ≤ shape_budget).
    let beta_at = |c: i32, i: usize| {
        if q[i] <= Q_SILENCE_X4 {
            return 0;
        }
        let v = (c + q[i] - LOG2W_X4[i % NUM_BANDS]).clamp(0, BETA_E8_MAX);
        if v < 8 { 0 } else { v }
    };
    let total_for = |c: i32| -> i64 {
        (0..q.len())
            .map(|i| i64::from(beta_at(c, i)) * band_width(i % NUM_BANDS) as i64)
            .sum()
    };
    // Наибольший C, при котором суммарная аллокация не превышает бюджет
    // (total_for монотонно не убывает по C).
    let (mut lo, mut hi) = C_SEARCH;
    while lo < hi {
        let mid = lo + (hi - lo + 1) / 2;
        if total_for(mid) <= s_e8 {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    (0..q.len()).map(|i| beta_at(lo, i) as u8).collect()
}

/// Параметр Райса для формы: `max(0, β − 1)` в целых битах.
pub(crate) fn rice_k_for_beta(beta_e8: u8) -> u32 {
    if beta_e8 >= 16 {
        u32::from(beta_e8 / 8 - 1)
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log2w_table_matches_band_widths() {
        for (b, &logw) in LOG2W_X4.iter().enumerate() {
            let exact = (4.0 * (band_width(b) as f64).log2()).round() as i32;
            assert_eq!(logw, exact, "band {b}");
        }
    }

    #[test]
    fn zero_budget_allocates_nothing() {
        let q = vec![10i32; NUM_BANDS];
        assert!(compute_alloc(&q, 1, 0).iter().all(|&b| b == 0));
    }

    #[test]
    fn louder_band_gets_more_bits() {
        let mut q = vec![0i32; NUM_BANDS];
        q[3] = 80;
        let beta = compute_alloc(&q, 1, 500);
        assert!(beta[3] > beta[10]);
    }

    #[test]
    fn budget_is_respected_and_saturates() {
        let q = vec![0i32; 2 * NUM_BANDS];
        for budget in [0u64, 100, 1000, 10_000, 1_000_000] {
            let beta = compute_alloc(&q, 2, budget);
            let total: i64 = beta
                .iter()
                .enumerate()
                .map(|(i, &b)| i64::from(b) * band_width(i % NUM_BANDS) as i64)
                .sum();
            assert!(total <= budget as i64 * 8, "budget {budget}: total {total}");
            assert!(beta.iter().all(|&b| i32::from(b) <= BETA_E8_MAX));
        }
        // Огромный бюджет — все полосы у капа.
        let beta = compute_alloc(&q, 2, 1_000_000);
        assert!(beta.iter().all(|&b| i32::from(b) == BETA_E8_MAX));
    }

    #[test]
    fn rice_k_mapping() {
        assert_eq!(rice_k_for_beta(0), 0);
        assert_eq!(rice_k_for_beta(15), 0);
        assert_eq!(rice_k_for_beta(16), 1);
        assert_eq!(rice_k_for_beta(64), 7);
    }
}
