//! Знаковая фикс-пойнт арифметика **Q32.32** (next-architecture.md §8.1, FGP-CRYPTO §10).
//!
//! Consensus-critical пути (демерредж, множители, аппроксимации) считаются целочисленно —
//! `f64` запрещён: расхождение порядка операций над плавающей точкой у двух реализаций
//! (сервер / wasm-клиент) дало бы ложный «несходящийся» реплей журнала. Правила:
//!
//! - представление: значение = `raw / 2^32`, `raw: i64`; промежуточные произведения — `i128`;
//! - округление: **round-half-even** (банковское) во всех делениях/сдвигах;
//! - переполнение: **saturate** к границам `i64` (не паника, не wrap) — как FGP-CRYPTO §10.
//!
//! Балансы хранятся целочисленно в [`crate::amount::Grains`]; фикс-пойнт используется только для
//! коэффициентов (доля демерреджа в `[0,1]` и т.п.) и для применения коэффициента к сумме.

use serde::{Deserialize, Serialize};

/// Число дробных бит формата Q32.32.
pub const FRAC_BITS: u32 = 32;

/// `1.0` в сыром представлении (`2^32`).
pub const ONE_RAW: i64 = 1_i64 << FRAC_BITS;

/// Знаковое фикс-пойнт число Q32.32.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Fixed(pub i64);

impl Fixed {
    /// `0.0`.
    pub const ZERO: Fixed = Fixed(0);
    /// `1.0`.
    pub const ONE: Fixed = Fixed(ONE_RAW);

    /// Из целого числа (насыщается при выходе за диапазон Q32.32).
    pub fn from_int(value: i64) -> Fixed {
        match value.checked_shl(FRAC_BITS) {
            Some(raw) if (value >> (63 - FRAC_BITS)) == (value >> 63) => Fixed(raw),
            _ if value > 0 => Fixed(i64::MAX),
            _ => Fixed(i64::MIN),
        }
    }

    /// Из отношения `num/den` с round-half-even. `den == 0` → насыщение по знаку.
    pub fn from_ratio(num: i64, den: i64) -> Fixed {
        if den == 0 {
            return if num >= 0 {
                Fixed(i64::MAX)
            } else {
                Fixed(i64::MIN)
            };
        }
        let scaled = (num as i128) << FRAC_BITS;
        Fixed(saturate_i128(div_round_half_even(scaled, den as i128)))
    }

    /// Возведение в целую неотрицательную степень (exponentiation by squaring).
    /// Детерминированно; используется для геометрического демерреджа `(1-δ)^n`.
    pub fn pow(self, mut exp: u64) -> Fixed {
        let mut base = self;
        let mut acc = Fixed::ONE;
        while exp > 0 {
            if exp & 1 == 1 {
                acc = acc * base;
            }
            exp >>= 1;
            if exp > 0 {
                base = base * base;
            }
        }
        acc
    }

    /// Применить коэффициент к целочисленной сумме: `round_half_even(value * self)`.
    /// Используется для демерреджа/долей; результат насыщается к `i64`.
    pub fn apply_to(self, value: i64) -> i64 {
        let scaled = (value as i128) * (self.0 as i128);
        saturate_i128(shr_round_half_even(scaled, FRAC_BITS))
    }

    /// Приблизительное значение как `f64` — **только для тестов/диагностики**, не для consensus.
    pub fn to_f64_lossy(self) -> f64 {
        self.0 as f64 / ONE_RAW as f64
    }
}

/// Произведение двух чисел Q32.32 (round-half-even, saturate).
impl std::ops::Mul for Fixed {
    type Output = Fixed;

    fn mul(self, other: Fixed) -> Fixed {
        let product = (self.0 as i128) * (other.0 as i128);
        Fixed(saturate_i128(shr_round_half_even(product, FRAC_BITS)))
    }
}

/// `n >> shift` с округлением half-to-even. `n` может быть отрицательным.
pub fn shr_round_half_even(n: i128, shift: u32) -> i128 {
    if shift == 0 {
        return n;
    }
    let divisor = 1_i128 << shift;
    div_round_half_even(n, divisor)
}

/// `n / divisor` с округлением half-to-even (`divisor > 0`).
pub fn div_round_half_even(n: i128, divisor: i128) -> i128 {
    debug_assert!(divisor > 0, "divisor must be positive");
    // Евклидово деление: остаток всегда в [0, divisor).
    let q = n.div_euclid(divisor);
    let r = n.rem_euclid(divisor);
    let twice = r * 2;
    if twice < divisor {
        q
    } else if twice > divisor {
        q + 1
    } else if q & 1 == 0 {
        q // ничья → к чётному
    } else {
        q + 1
    }
}

/// Насыщение `i128` в диапазон `i64`.
pub fn saturate_i128(v: i128) -> i64 {
    if v > i64::MAX as i128 {
        i64::MAX
    } else if v < i64::MIN as i128 {
        i64::MIN
    } else {
        v as i64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_times_one_is_one() {
        assert_eq!(Fixed::ONE * Fixed::ONE, Fixed::ONE);
    }

    #[test]
    fn half_times_value_rounds_half_even() {
        let half = Fixed::from_ratio(1, 2);
        // 5 * 0.5 = 2.5 → ближайшее чётное = 2
        assert_eq!(half.apply_to(5), 2);
        // 7 * 0.5 = 3.5 → ближайшее чётное = 4
        assert_eq!(half.apply_to(7), 4);
        // 3 * 0.5 = 1.5 → 2
        assert_eq!(half.apply_to(3), 2);
    }

    #[test]
    fn pow_zero_is_one() {
        let x = Fixed::from_ratio(3, 4);
        assert_eq!(x.pow(0), Fixed::ONE);
    }

    #[test]
    fn pow_is_deterministic_and_close_to_repeated_mul() {
        // Бинарное возведение в степень округляет иначе, чем последовательное умножение
        // (меньше шагов — меньше накопленной ошибки); нормативен именно pow-путь.
        let x = Fixed::from_ratio(999, 1000); // 0.999
        let mut manual = Fixed::ONE;
        for _ in 0..17 {
            manual = manual * x;
        }
        let p = x.pow(17);
        assert_eq!(p, x.pow(17), "детерминизм");
        assert!(
            (p.0 - manual.0).abs() < 16,
            "расхождение путей в пределах младших бит"
        );
    }

    #[test]
    fn from_ratio_is_deterministic_and_bounded() {
        let r = Fixed::from_ratio(1, 3);
        // 1/3 ≈ 0.3333333; проверим что в разумной окрестности и стабильно.
        assert_eq!(r, Fixed::from_ratio(1, 3));
        assert!((r.to_f64_lossy() - 0.3333333).abs() < 1e-6);
    }

    #[test]
    fn apply_to_one_is_identity() {
        assert_eq!(Fixed::ONE.apply_to(1_234_567), 1_234_567);
        assert_eq!(Fixed::ONE.apply_to(0), 0);
    }

    #[test]
    fn decay_factor_never_increases_value() {
        let f = Fixed::from_ratio(9990, 10000); // 0.999
        let factor = f.pow(365);
        let start = 1_000_000_000_i64;
        let remaining = factor.apply_to(start);
        assert!(remaining < start);
        assert!(remaining > 0);
    }

    #[test]
    fn negative_rounding_is_half_even() {
        // -5 / 2 = -2.5 → ближайшее чётное = -2
        assert_eq!(div_round_half_even(-5, 2), -2);
        // -7 / 2 = -3.5 → -4
        assert_eq!(div_round_half_even(-7, 2), -4);
    }

    #[test]
    fn saturation_clamps() {
        assert_eq!(saturate_i128(i128::MAX), i64::MAX);
        assert_eq!(saturate_i128(i128::MIN), i64::MIN);
        assert_eq!(saturate_i128(42), 42);
    }
}
