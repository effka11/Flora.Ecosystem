//! Энергии полос: квантование в четвертях log2 (FAC.md, «Энергии»).

use crate::bands::{NUM_BANDS, band_range};
use crate::qmath::pow2_e8;

pub(crate) const ENERGY_EPS: f64 = 1e-10;

/// Квантованный индекс энергии и истинный gain (`sqrt(E)`) полосы.
pub(crate) fn analyze_plane(coeffs: &[f32], q_out: &mut [i32], gain_out: &mut [f32]) {
    debug_assert_eq!(q_out.len(), NUM_BANDS);
    debug_assert_eq!(gain_out.len(), NUM_BANDS);
    for b in 0..NUM_BANDS {
        let e: f64 = coeffs[band_range(b)]
            .iter()
            .map(|&x| f64::from(x) * f64::from(x))
            .sum::<f64>()
            + ENERGY_EPS;
        q_out[b] = (4.0 * e.log2()).round() as i32;
        gain_out[b] = e.sqrt() as f32;
    }
}

/// Декодированный gain: `2^(q/8)` (q — четверти log2 энергии, gain — корень).
pub(crate) fn dequant_gain(q: i32) -> f32 {
    pow2_e8(q)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bands::CODED_BINS;

    #[test]
    fn gain_quantization_error_is_within_half_step() {
        // Шаг квантования энергии 0.25 log2 => ошибка gain <= 0.0625 log2 (+ округление).
        let mut coeffs = vec![0f32; CODED_BINS];
        let mut state = 0x1234_5678u32;
        for c in coeffs.iter_mut() {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            *c = (state as f32 / 2f32.powi(31)) - 1.0;
        }
        let mut q = [0i32; NUM_BANDS];
        let mut g = [0f32; NUM_BANDS];
        analyze_plane(&coeffs, &mut q, &mut g);
        for b in 0..NUM_BANDS {
            let ratio = f64::from(dequant_gain(q[b])) / f64::from(g[b]);
            assert!(ratio.log2().abs() <= 0.063, "band {b}: ratio {ratio}");
        }
    }
}
