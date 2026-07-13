//! Точная кросс-платформенная степень двойки с шагом 1/8 (FAC.md, «Форма»):
//! нормативные мантиссы f32 + сдвиг порядка, без libm.

pub(crate) const MANT_E8: [f32; 8] = [
    1.0,
    1.090_507_7,
    1.189_207_1,
    1.296_839_6,
    core::f32::consts::SQRT_2,
    1.542_210_8,
    1.681_792_9,
    1.834_008,
];

/// `2^(m/8)` для целого `m` (восьмые доли log2). Порядок ограничен ±126,
/// чтобы результат оставался конечным даже на враждебном битстриме.
pub(crate) fn pow2_e8(m: i32) -> f32 {
    let e = m.div_euclid(8).clamp(-126, 126);
    let j = m.rem_euclid(8) as usize;
    MANT_E8[j] * 2f32.powi(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_f64_pow() {
        for m in -400..=400 {
            let exact = 2f64.powf(f64::from(m) / 8.0);
            let got = f64::from(pow2_e8(m));
            assert!(
                (got - exact).abs() / exact < 1e-6,
                "m={m}: got {got}, exact {exact}"
            );
        }
    }
}
