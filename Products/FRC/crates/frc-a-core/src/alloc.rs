//! Аллокация битов по полосам (FRC-A.md, «Аллокация»).
//!
//! Перцептивный water-filling: β[b] = C + α·(q[b] − 4·log2 width[b]) + tilt[b],
//! где C — общий уровень, подобранный под бюджет, α = 3/4 — экспонента
//! плотности энергии (чистый MMSE — α = 1 — перекармливает громкие полосы:
//! маскирование внутри полосы растёт медленнее её энергии), tilt —
//! сигналируемый в кадре наклон НЧ↔ВЧ. Вход — только квантованные энергии,
//! trim и бюджет, поэтому энкодер и декодер получают идентичный результат
//! без передачи таблицы аллокации в битстриме.

use crate::bands::{NUM_BANDS, band_width};

/// Кап целевых бит на коэффициент: 64/8 = 8 бит.
pub(crate) const BETA_E8_MAX: i32 = 64;

/// Экспонента плотности энергии α = ALPHA_NUM / 2^ALPHA_SHIFT = 3/4
/// (нормативно; сдвиг — floor, детерминирован для отрицательных).
const ALPHA_NUM: i32 = 3;
const ALPHA_SHIFT: u32 = 2;

/// Нейтральное значение сигнализируемого наклона аллокации (см. `tilt_e8`).
pub(crate) const TRIM_NEUTRAL: i32 = 4;
/// Число сырых битов трима в кадре; значения 0..=7.
pub(crate) const TRIM_RAW_BITS: u32 = 3;

/// Нормативная таблица `round(4·log2(width[b]))`.
pub(crate) const LOG2W_X4: [i32; NUM_BANDS] = [
    12, 12, 12, 12, 12, 12, 12, 12, 16, 16, 16, 16, 20, 20, 20, 22, 22, 24, 26, 29, 30,
];

/// Диапазон бинарного поиска C: при −3000 все β = 0 (|α·d| ≤ 791, |tilt| ≤ 40),
/// при 3000 все β = 64.
const C_SEARCH: (i32, i32) = (-3000, 3000);

/// Полосы с энергией на уровне epsilon-пола энкодера (E ≈ 1e-10 → q ≈ −133)
/// не кодируются: цифровая тишина не должна тратить бюджет на нули формы.
/// Тот же порог гейтит anti-collapse (не вводить шум в цифровую тишину).
pub(crate) const Q_SILENCE_X4: i32 = -132;

/// Перцептивно взвешенная плотность энергии полосы: α·(q − 4·log2 w),
/// floor-сдвиг нормативен.
pub(crate) fn density_e8(q: i32, band: usize) -> i32 {
    (ALPHA_NUM * (q - LOG2W_X4[band])) >> ALPHA_SHIFT
}

/// Сигнализируемый наклон аллокации: `((trim − 4)·(2b + 1 − 21)) >> 2` восьмых
/// бита. trim > 4 сдвигает биты к ВЧ, trim < 4 — к НЧ; шаг ±5 e8 на краях
/// спектра (≈ 0.6 бит/коэфф дифференциала НЧ↔ВЧ на единицу трима).
pub(crate) fn tilt_e8(trim: u8, band: usize) -> i32 {
    ((i32::from(trim) - TRIM_NEUTRAL) * (2 * band as i32 + 1 - NUM_BANDS as i32)) >> 2
}

/// Целевые биты на коэффициент в 1/8 бита, по плоскостям и полосам
/// (`planes * NUM_BANDS`, layout плоскость-мажорный, как у `q`).
pub(crate) fn compute_alloc(q: &[i32], planes: usize, shape_budget_bits: u64, trim: u8) -> Vec<u8> {
    debug_assert_eq!(q.len(), planes * NUM_BANDS);
    debug_assert!(trim < 1 << TRIM_RAW_BITS);
    let s_e8 = shape_budget_bits as i64 * 8;
    // Полосы дешевле 1 бит/коэфф (β < 8) не кодируются. PVQ выбирает книгу
    // максимальной мощности, укладывающуюся в аллокацию полосы, поэтому
    // фактическая стоимость формы никогда не превышает Σ β·width/8 ≤ бюджета;
    // правило β ≥ 8 дополнительно гарантирует K ≥ 1 (полоса с β > 0 не пуста):
    // 8·W ≥ ⌈8·log2(2W)⌉ для всех ширин W ≥ 2.
    let beta_at = |c: i32, i: usize| {
        if q[i] <= Q_SILENCE_X4 {
            return 0;
        }
        let b = i % NUM_BANDS;
        let v = (c + density_e8(q[i], b) + tilt_e8(trim, b)).clamp(0, BETA_E8_MAX);
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
        assert!(
            compute_alloc(&q, 1, 0, TRIM_NEUTRAL as u8)
                .iter()
                .all(|&b| b == 0)
        );
    }

    #[test]
    fn louder_band_gets_more_bits() {
        let mut q = vec![0i32; NUM_BANDS];
        q[3] = 80;
        let beta = compute_alloc(&q, 1, 500, TRIM_NEUTRAL as u8);
        assert!(beta[3] > beta[10]);
    }

    /// Экспонента α = 3/4: разница аллокаций двух полос — 3/4 разницы их
    /// плотностей (сжатие динамики против MMSE).
    #[test]
    fn alpha_compresses_allocation_dynamics() {
        let mut q = vec![-500i32; NUM_BANDS];
        // Полосы одной ширины (0..8): плотности отличаются на 64 единицы q.
        q[2] = 64;
        q[5] = 0;
        // Бюджет 70 бит: C = 20, обе полосы кодируются без клампов.
        let beta = compute_alloc(&q, 1, 70, TRIM_NEUTRAL as u8);
        assert!(beta[2] > 0 && beta[5] > 0, "{beta:?}");
        // MMSE дал бы разницу 64 e8; α = 3/4 → 48 e8.
        assert_eq!(i32::from(beta[2]) - i32::from(beta[5]), 48, "{beta:?}");
    }

    /// Трим сдвигает биты между НЧ и ВЧ при том же бюджете.
    #[test]
    fn trim_tilts_allocation() {
        let q = vec![40i32; NUM_BANDS];
        // Бюджет достаточен, чтобы при нейтральном триме кодировались все
        // полосы (β(20) = 8) — сравнения краёв не вырождаются.
        let budget = 1300u64;
        let neutral = compute_alloc(&q, 1, budget, 4);
        let hf = compute_alloc(&q, 1, budget, 7);
        let lf = compute_alloc(&q, 1, budget, 0);
        // ВЧ-трим: последняя полоса получает больше, первая — меньше.
        assert!(
            hf[NUM_BANDS - 1] > neutral[NUM_BANDS - 1],
            "{hf:?} vs {neutral:?}"
        );
        assert!(hf[0] < neutral[0], "{hf:?} vs {neutral:?}");
        // НЧ-трим — наоборот.
        assert!(lf[0] > neutral[0], "{lf:?} vs {neutral:?}");
        assert!(
            lf[NUM_BANDS - 1] < neutral[NUM_BANDS - 1],
            "{lf:?} vs {neutral:?}"
        );
        // Бюджет соблюдён во всех тримах.
        for beta in [&neutral, &hf, &lf] {
            let total: i64 = beta
                .iter()
                .enumerate()
                .map(|(i, &b)| i64::from(b) * band_width(i % NUM_BANDS) as i64)
                .sum();
            assert!(total <= budget as i64 * 8);
        }
    }

    #[test]
    fn tilt_is_antisymmetric_and_bounded() {
        for trim in 0..8u8 {
            for b in 0..NUM_BANDS {
                let t = tilt_e8(trim, b);
                assert!(t.abs() <= 20, "trim={trim} b={b}: {t}");
            }
        }
        assert_eq!(tilt_e8(4, 0), 0);
        assert_eq!(tilt_e8(4, NUM_BANDS - 1), 0);
        assert!(tilt_e8(7, NUM_BANDS - 1) > 0);
        assert!(tilt_e8(7, 0) < 0);
        assert!(tilt_e8(0, NUM_BANDS - 1) < 0);
        assert!(tilt_e8(0, 0) > 0);
    }

    #[test]
    fn budget_is_respected_and_saturates() {
        let q = vec![0i32; 2 * NUM_BANDS];
        for trim in [0u8, 4, 7] {
            for budget in [0u64, 100, 1000, 10_000, 1_000_000] {
                let beta = compute_alloc(&q, 2, budget, trim);
                let total: i64 = beta
                    .iter()
                    .enumerate()
                    .map(|(i, &b)| i64::from(b) * band_width(i % NUM_BANDS) as i64)
                    .sum();
                assert!(
                    total <= budget as i64 * 8,
                    "trim {trim} budget {budget}: total {total}"
                );
                assert!(beta.iter().all(|&b| i32::from(b) <= BETA_E8_MAX));
            }
            // Огромный бюджет — все полосы у капа.
            let beta = compute_alloc(&q, 2, 1_000_000, trim);
            assert!(beta.iter().all(|&b| i32::from(b) == BETA_E8_MAX));
        }
    }
}
