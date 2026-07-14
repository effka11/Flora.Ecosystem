//! Энергии полос: coarse-квантование в четвертях log2 (управляет аллокацией)
//! + fine-уточнение в шестнадцатых log2 для кодируемых полос (FRC-A.md, «Энергии»).

use crate::bands::{NUM_BANDS, band_range};
use crate::qmath::{pow2_e8, pow2_e64};

pub(crate) const ENERGY_EPS: f64 = 1e-10;

/// Число fine-битов на кодируемую полосу (β > 0).
pub(crate) const FINE_BITS: u32 = 2;

/// Анализ плоскости: coarse-индекс `q = round(4·log2 E)`, fine-индекс
/// `u ∈ [0, 3]` (позиция внутри coarse-ячейки в 1/16 log2) и истинный gain.
pub(crate) fn analyze_plane(
    coeffs: &[f32],
    q_out: &mut [i32],
    fine_out: &mut [u8],
    gain_out: &mut [f32],
) {
    debug_assert_eq!(q_out.len(), NUM_BANDS);
    debug_assert_eq!(fine_out.len(), NUM_BANDS);
    debug_assert_eq!(gain_out.len(), NUM_BANDS);
    for b in 0..NUM_BANDS {
        let e: f64 = coeffs[band_range(b)]
            .iter()
            .map(|&x| f64::from(x) * f64::from(x))
            .sum::<f64>()
            + ENERGY_EPS;
        let e16 = 16.0 * e.log2();
        let q = (e16 / 4.0).round() as i32;
        let res = e16 - 4.0 * f64::from(q); // ∈ [−2, 2)
        q_out[b] = q;
        fine_out[b] = (res.floor() as i32 + 2).clamp(0, 3) as u8;
        gain_out[b] = e.sqrt() as f32;
    }
}

/// Gain только по coarse-индексу: `2^(q/8)` (для полос без fine-битов).
pub(crate) fn dequant_gain(q: i32) -> f32 {
    pow2_e8(q)
}

/// Gain с fine-уточнением: `ê16 = 4q + (u − 1.5)`, gain `= 2^(ê16/32)`
/// — вычисляется точной таблицей 1/64 (`qmath`), детерминированно на всех
/// платформах: `8q + 2u − 3` шестьдесятчетвёртых log2.
pub(crate) fn dequant_gain_fine(q: i32, u: u8) -> f32 {
    pow2_e64(8 * q + 2 * i32::from(u) - 3)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bands::CODED_BINS;

    fn random_coeffs() -> Vec<f32> {
        let mut coeffs = vec![0f32; CODED_BINS];
        let mut state = 0x1234_5678u32;
        for c in coeffs.iter_mut() {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            *c = (state as f32 / 2f32.powi(31)) - 1.0;
        }
        coeffs
    }

    #[test]
    fn coarse_gain_error_is_within_half_step() {
        // Шаг coarse 0.25 log2 энергии => ошибка gain <= 0.0625 log2 (+ округление).
        let coeffs = random_coeffs();
        let mut q = [0i32; NUM_BANDS];
        let mut fine = [0u8; NUM_BANDS];
        let mut g = [0f32; NUM_BANDS];
        analyze_plane(&coeffs, &mut q, &mut fine, &mut g);
        for b in 0..NUM_BANDS {
            let ratio = f64::from(dequant_gain(q[b])) / f64::from(g[b]);
            assert!(ratio.log2().abs() <= 0.063, "band {b}: ratio {ratio}");
        }
    }

    #[test]
    fn fine_gain_error_is_within_sixteenth_step() {
        // Ячейка fine 1/16 log2 энергии => ошибка gain <= 1/64 log2.
        let coeffs = random_coeffs();
        let mut q = [0i32; NUM_BANDS];
        let mut fine = [0u8; NUM_BANDS];
        let mut g = [0f32; NUM_BANDS];
        analyze_plane(&coeffs, &mut q, &mut fine, &mut g);
        for b in 0..NUM_BANDS {
            let ratio = f64::from(dequant_gain_fine(q[b], fine[b])) / f64::from(g[b]);
            assert!(ratio.log2().abs() <= 0.016, "band {b}: ratio {ratio}");
        }
    }
}
