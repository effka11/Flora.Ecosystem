//! Аллокация битов по полосам (FAC.md, «Аллокация»).
//!
//! Общая целочисленная функция энкодера и декодера: вход — только квантованные
//! энергии и бюджет формы, поэтому обе стороны получают идентичный результат
//! без передачи таблицы аллокации в битстриме.

use crate::bands::{NUM_BANDS, band_width};

/// Кап целевых бит на коэффициент: 64/8 = 8 бит.
pub(crate) const BETA_E8_MAX: i64 = 64;

/// Целевые биты на коэффициент в 1/8 бита, по плоскостям и полосам
/// (`planes * NUM_BANDS`, layout плоскость-мажорный, как у `q`).
pub(crate) fn compute_alloc(q: &[i32], planes: usize, shape_budget_bits: u64) -> Vec<u8> {
    debug_assert_eq!(q.len(), planes * NUM_BANDS);
    let qmax = q.iter().copied().max().unwrap_or(0);
    let mut weight = vec![0i64; q.len()];
    let mut denom: i64 = 0;
    for p in 0..planes {
        for b in 0..NUM_BANDS {
            let i = p * NUM_BANDS + b;
            let w = i64::from((q[i] - qmax + 128).clamp(0, 128) + 8);
            weight[i] = w;
            denom += w * band_width(b) as i64;
        }
    }
    let s_e8 = shape_budget_bits as i64 * 8;
    weight
        .iter()
        .map(|&w| (s_e8 * w / denom).clamp(0, BETA_E8_MAX) as u8)
        .collect()
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
    fn zero_budget_allocates_nothing() {
        let q = vec![10i32; NUM_BANDS];
        assert!(compute_alloc(&q, 1, 0).iter().all(|&b| b == 0));
    }

    #[test]
    fn louder_band_gets_more_bits() {
        let mut q = vec![0i32; NUM_BANDS];
        q[3] = 80;
        let beta = compute_alloc(&q, 1, 1000);
        assert!(beta[3] > beta[10]);
    }

    #[test]
    fn beta_is_capped() {
        let q = vec![0i32; NUM_BANDS];
        let beta = compute_alloc(&q, 1, 1_000_000);
        assert!(beta.iter().all(|&b| i64::from(b) <= BETA_E8_MAX));
    }

    #[test]
    fn rice_k_mapping() {
        assert_eq!(rice_k_for_beta(0), 0);
        assert_eq!(rice_k_for_beta(15), 0);
        assert_eq!(rice_k_for_beta(16), 1);
        assert_eq!(rice_k_for_beta(64), 7);
    }
}
