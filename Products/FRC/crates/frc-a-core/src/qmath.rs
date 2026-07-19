//! Точная кросс-платформенная степень двойки с шагом 1/64 (FRC-A.md, «Форма»):
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

/// Мантиссы Q60 порога `pow2_floor_e8`: `MANT_Q60[j] = floor(2^(j/8) · 2^60)`.
/// Нормативные целые константы битстрима (проверяются тестом точного floor
/// через целочисленную 8-ю степень — без float).
const MANT_Q60: [u64; 8] = [
    1_152_921_504_606_846_976,
    1_257_269_815_929_830_108,
    1_371_062_456_318_104_877,
    1_495_154_210_581_915_421,
    1_630_477_228_166_597_776,
    1_778_048_025_250_290_523,
    1_938_975_120_585_633_118,
    2_114_467_362_444_183_333,
];

/// Наибольшее целое ≤ `2^(c/8)` по нормативной таблице (насыщение в u64::MAX):
/// `(MANT_Q60[c mod 8] << (c div 8)) >> 60`. Порог допустимости кодовой книги
/// PVQ: книга мощности `V` укладывается в `c` восьмых бита ⇔ `V ≤ pow2_floor_e8(c)`.
pub(crate) fn pow2_floor_e8(c: u32) -> u64 {
    let e = c / 8;
    if e >= 64 {
        return u64::MAX;
    }
    let v = (u128::from(MANT_Q60[(c % 8) as usize]) << e) >> 60;
    u64::try_from(v).unwrap_or(u64::MAX)
}

/// Наименьшее `c` (1/8 бита), при котором `pow2_floor_e8(c) ≥ v` — нормативная
/// стоимость равномерного символа с `v` исходами (`⌈8·log2 v⌉` с точностью
/// таблицы; для степеней двойки — точно `8·log2 v`).
pub(crate) fn cost_e8(v: u64) -> u32 {
    debug_assert!(v >= 1);
    if v == 1 {
        return 0;
    }
    let base = (63 - v.leading_zeros()) * 8; // 2^(base/8) ≤ v
    (base..base + 8)
        .find(|&c| pow2_floor_e8(c) >= v)
        .unwrap_or(base + 8)
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

    /// Точная проверка нормативной таблицы: `MANT_Q60[j] = floor(2^((480+j)/8))`
    /// ⇔ `y⁸ ≤ 2^(480+j) < (y+1)⁸` — целочисленно, через 512-битные степени.
    #[test]
    fn mant_q60_is_exact_floor() {
        // Сравнение y⁸ с 2^(480+j): y < 2^61, y² в u128 точно, дальше лимбы u64.
        fn pow8_le_pow2(y: u64, e: u32) -> bool {
            let y2 = u128::from(y) * u128::from(y);
            let (a, b) = ((y2 >> 64) as u64, y2 as u64);
            // y⁴ = (a·2^64 + b)² → 4 лимба.
            let mut y4 = [0u64; 4];
            let acc = |limbs: &mut [u64], i: usize, v: u128| {
                let mut carry = v;
                let mut idx = i;
                while carry > 0 {
                    let sum = u128::from(limbs[idx]) + (carry & u128::from(u64::MAX));
                    limbs[idx] = sum as u64;
                    carry = (carry >> 64) + (sum >> 64);
                    idx += 1;
                }
            };
            acc(&mut y4, 0, u128::from(b) * u128::from(b));
            let ab = u128::from(a) * u128::from(b);
            acc(&mut y4, 1, ab);
            acc(&mut y4, 1, ab);
            acc(&mut y4, 2, u128::from(a) * u128::from(a));
            // y⁸ = y4² → 8 лимбов (школьное умножение).
            let mut y8 = [0u64; 8];
            for i in 0..4 {
                for j in 0..4 {
                    acc(&mut y8, i + j, u128::from(y4[i]) * u128::from(y4[j]));
                }
            }
            let mut target = [0u64; 8];
            target[(e / 64) as usize] = 1u64 << (e % 64);
            // y⁸ ≤ 2^e — лексикографически со старших лимбов.
            for i in (0..8).rev() {
                if y8[i] != target[i] {
                    return y8[i] < target[i];
                }
            }
            true
        }

        let mut exact = [0u64; 8];
        for (j, out) in exact.iter_mut().enumerate() {
            let (mut lo, mut hi) = (1u64 << 60, 1u64 << 61); // floor ∈ [lo, hi)
            while lo + 1 < hi {
                let mid = lo + (hi - lo) / 2;
                if pow8_le_pow2(mid, 480 + j as u32) {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            *out = lo;
        }
        assert_eq!(MANT_Q60, exact);
    }

    #[test]
    fn pow2_floor_e8_matches_f64_and_saturates() {
        for c in 0..=505u32 {
            let got = pow2_floor_e8(c);
            let exact = 2f64.powf(f64::from(c) / 8.0);
            if exact < 1.8e18 {
                let g = got as f64;
                assert!(
                    g <= exact * (1.0 + 1e-12) && exact < (g + 1.0) * (1.0 + 1e-12),
                    "c={c}: got {got}, exact {exact}"
                );
            }
        }
        assert_eq!(pow2_floor_e8(0), 1);
        assert_eq!(pow2_floor_e8(8), 2);
        assert_eq!(pow2_floor_e8(80), 1024);
        assert_eq!(pow2_floor_e8(512), u64::MAX);
    }

    #[test]
    fn cost_e8_is_ceil_log2() {
        assert_eq!(cost_e8(1), 0);
        assert_eq!(cost_e8(2), 8);
        assert_eq!(cost_e8(3), 13); // ⌈8·log2 3⌉ = ⌈12.68⌉
        assert_eq!(cost_e8(4), 16);
        assert_eq!(cost_e8(1024), 80);
        for v in [5u64, 7, 100, 4095, 1 << 40, u64::MAX] {
            let c = cost_e8(v);
            assert!(pow2_floor_e8(c) >= v, "v={v}: cost {c} too small");
            assert!(
                c == 0 || pow2_floor_e8(c - 1) < v,
                "v={v}: cost {c} not minimal"
            );
            let exact = 8.0 * (v as f64).log2();
            assert!(
                f64::from(c) >= exact - 1e-6 && f64::from(c) <= exact + 1.0 + 1e-6,
                "v={v}: cost {c} vs 8·log2 {exact}"
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
