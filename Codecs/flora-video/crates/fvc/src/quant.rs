//! Квантование (энкодер) и дезквантование (нормативное).

use crate::tables::{AC_STEP, DC_STEP};
use crate::transform::COEFF_CLAMP;

/// Максимальный кодируемый уровень (класс 13, см. tokens.rs).
pub const MAX_LEVEL: i32 = 8192;

#[inline]
pub fn ac_step(qp: u8) -> i32 {
    AC_STEP[qp as usize]
}

#[inline]
pub fn dc_step(qp: u8) -> i32 {
    DC_STEP[qp as usize]
}

/// Дезквантование уровня (нормативное): произведение с клампом.
#[inline]
pub fn dequant_level(level: i32, step: i32) -> i32 {
    (level.saturating_mul(step)).clamp(-COEFF_CLAMP, COEFF_CLAMP)
}

/// Квантование блока (только энкодер): deadzone 3/8 для AC, округление к ближайшему для DC.
/// `coeffs` — raster, `levels` — raster. Возвращает число ненулевых уровней.
pub fn quantize_block(coeffs: &[i32], levels: &mut [i32], qp: u8) -> usize {
    let (dc, ac) = (i64::from(dc_step(qp)), i64::from(ac_step(qp)));
    let mut nnz = 0;
    for (i, (&c, l)) in coeffs.iter().zip(levels.iter_mut()).enumerate() {
        let (step, num_bias) = if i == 0 { (dc, dc) } else { (ac, ac * 3 / 4) };
        let a = i64::from(c.unsigned_abs());
        // deadzone-квант: floor((|c| + bias/2) / step), bias: DC=step (nearest), AC=3/8·step·2.
        let lv = ((a * 2 + num_bias) / (step * 2)).min(i64::from(MAX_LEVEL)) as i32;
        *l = if c < 0 { -lv } else { lv };
        if lv != 0 {
            nnz += 1;
        }
    }
    nnz
}

/// Дезквантование блока (нормативный путь, используется энкодером и декодером).
pub fn dequantize_block(levels: &[i32], out: &mut [i32], qp: u8) {
    let (dc, ac) = (dc_step(qp), ac_step(qp));
    for (i, (&l, o)) in levels.iter().zip(out.iter_mut()).enumerate() {
        let step = if i == 0 { dc } else { ac };
        *o = dequant_level(l, step);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transform::{forward, inverse};

    /// qp=0 — почти без потерь: шаг 8 = 1 ортонормальная единица.
    #[test]
    fn near_lossless_at_qp0() {
        let n = 8;
        let input: Vec<i32> = (0..64).map(|i| ((i * 37 + 11) % 511) - 255).collect();
        let mut coeffs = vec![0i32; 64];
        let mut levels = vec![0i32; 64];
        let mut deq = vec![0i32; 64];
        let mut recon = vec![0i32; 64];
        forward(&input, n, &mut coeffs);
        quantize_block(&coeffs, &mut levels, 0);
        dequantize_block(&levels, &mut deq, 0);
        inverse(&deq, n, &mut recon);
        for i in 0..64 {
            assert!((input[i] - recon[i]).abs() <= 4, "pos {i}: {} vs {}", input[i], recon[i]);
        }
    }

    #[test]
    fn step_doubles_every_8_qp() {
        for qp in 0..56u8 {
            let ratio = f64::from(ac_step(qp + 8)) / f64::from(ac_step(qp));
            assert!((ratio - 2.0).abs() < 0.15, "qp={qp}: ratio={ratio}");
        }
    }
}
