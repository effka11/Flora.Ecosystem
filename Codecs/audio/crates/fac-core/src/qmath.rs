//! Точная кросс-платформенная степень двойки с шагом 1/64 (FAC.md, «Форма»):
//! нормативная таблица мантисс, построенная const-eval цепочкой IEEE-умножений
//! (каждое умножение f64 корректно округлено => результат идентичен на всех
//! платформах), без libm в нормативном пути декодера.

/// `R = 2^(1/64)` (f64, 17 значащих цифр — нормативная константа).
const R_2_POW_1_64: f64 = 1.010_889_286_051_700_5;

/// `MANT64[j] = 2^(j/64)` как f32 (через накопление в f64 и приведение).
const MANT64: [f32; 64] = build_mant64();

const fn build_mant64() -> [f32; 64] {
    let mut out = [0f32; 64];
    let mut acc = 1f64;
    let mut j = 0;
    while j < 64 {
        out[j] = acc as f32;
        acc *= R_2_POW_1_64;
        j += 1;
    }
    out
}

/// `2^(m/64)` для целого `m` (шестьдесятчетвёртые доли log2). Порядок ограничен
/// ±126, чтобы результат оставался конечным даже на враждебном битстриме.
pub(crate) fn pow2_e64(m: i32) -> f32 {
    let e = m.div_euclid(64).clamp(-126, 126);
    let j = m.rem_euclid(64) as usize;
    MANT64[j] * 2f32.powi(e)
}

/// `2^(m/8)` для целого `m` (восьмые доли log2) — шаги квантования формы.
pub(crate) fn pow2_e8(m: i32) -> f32 {
    pow2_e64(m.saturating_mul(8))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn r_constant_is_2_pow_1_64() {
        let exact = 2f64.powf(1.0 / 64.0);
        assert!(
            (R_2_POW_1_64 - exact).abs() < 1e-15,
            "R={R_2_POW_1_64}, exact={exact}"
        );
    }

    #[test]
    fn mant_table_matches_f64_pow() {
        for (j, &m) in MANT64.iter().enumerate() {
            let exact = 2f64.powf(j as f64 / 64.0);
            assert!(
                (f64::from(m) - exact).abs() / exact < 1e-6,
                "j={j}: got {m}, exact {exact}"
            );
        }
    }

    #[test]
    fn pow2_e64_matches_f64_pow() {
        for m in -3200..=3200 {
            let exact = 2f64.powf(f64::from(m) / 64.0);
            let got = f64::from(pow2_e64(m));
            assert!(
                (got - exact).abs() / exact < 1e-6,
                "m={m}: got {got}, exact {exact}"
            );
        }
    }

    #[test]
    fn pow2_e8_matches_f64_pow() {
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
