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

/// Детерминированный целочисленный `≈ floor(64·log2(v))`, `v ≥ 1`
/// (метод последовательных возведений в квадрат; ошибки усечения только
/// занижают результат, поэтому `768 − log2_x64(f)` — верхняя оценка стоимости
/// бита с частотой `f/4096` в 1/64 бита). Без float — бит-в-бит на всех
/// платформах: нормативная функция учёта стоимости адаптивных битов.
pub(crate) fn log2_x64(v: u32) -> u64 {
    debug_assert!(v >= 1);
    let int_part = 31 - v.leading_zeros();
    let mut m = u64::from(v) << (31 - int_part); // мантисса в [2^31, 2^32)
    let mut frac = 0u64;
    for _ in 0..6 {
        m = (m * m) >> 31; // в [2^31, 2^33)
        frac <<= 1;
        if m >= 1u64 << 32 {
            frac |= 1;
            m >>= 1;
        }
    }
    u64::from(int_part) * 64 + frac
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

    /// `log2_x64` занижает точное значение не более чем на 2/64.
    #[test]
    fn log2_x64_is_tight_lower_bound() {
        for v in 1u32..=4096 {
            let exact = 64.0 * f64::from(v).log2();
            let got = log2_x64(v) as f64;
            assert!(
                got <= exact + 1e-9 && got > exact - 2.0,
                "v={v}: got {got}, exact {exact:.3}"
            );
        }
        assert_eq!(log2_x64(1), 0);
        assert_eq!(log2_x64(2048), 64 * 11);
        assert_eq!(log2_x64(4096), 64 * 12);
    }
}
