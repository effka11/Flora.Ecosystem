//! Детерминированная арифметика Q32.32 (FGP-CRYPTO §10).
//!
//! Consensus-critical вычисления FGP (веса, затухания, conviction, тэлли-агрегаты)
//! запрещают float: расхождение двух реализаций из-за порядка операций над `f64`
//! неотличимо от подмены тэлли и провоцирует ложный freeze (FGP §8.1, THREATS V-11).
//!
//! Нормативные свойства (спецификация — golden-вектора `docs/test-vectors/governance/`):
//! - формат **Q32.32** со знаком: `i64`, 32 бита целой части, 32 — дробной; промежуточные — `i128`;
//! - округление **round-half-even** во всех делениях и правых сдвигах;
//! - переполнение **насыщает** (saturate), не паникует и не заворачивается;
//! - `exp2` — таблица 256 интервалов (257 узлов) + линейная интерполяция; таблица строится
//!   в compile-time целочисленным алгоритмом (повторные isqrt), без единой float-операции;
//! - `log2` — поразрядное извлечение (32 итерации возведения в квадрат в Q2.62);
//! - трансцендентные кривые FGP §4 нормированы в базис 2 (`2^x`), поэтому никакие
//!   константы вида `ln 2`/`log2 e` ядру не нужны.

/// Число с фиксированной точкой Q32.32.
///
/// Диапазон ≈ ±2.15 · 10⁹ с шагом 2⁻³² ≈ 2.3 · 10⁻¹⁰. Операторы `+ - * /`
/// насыщают на границах диапазона; для явной обработки переполнения есть
/// `checked_*`-варианты.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Default)]
pub struct Fx(i64);

/// Число дробных битов формата.
pub const FRAC_BITS: u32 = 32;

const FRAC_MASK: i64 = (1 << FRAC_BITS) - 1;

impl Fx {
    pub const ZERO: Fx = Fx(0);
    pub const ONE: Fx = Fx(1 << FRAC_BITS);
    pub const TWO: Fx = Fx(2 << FRAC_BITS);
    pub const MAX: Fx = Fx(i64::MAX);
    pub const MIN: Fx = Fx(i64::MIN);

    /// Сырое битовое представление (для векторов и сериализации).
    pub const fn to_bits(self) -> i64 {
        self.0
    }

    /// Из сырого битового представления.
    pub const fn from_bits(bits: i64) -> Fx {
        Fx(bits)
    }

    /// Из целого. `i32` укладывается в целую часть всегда — конверсия точная.
    pub const fn from_int(v: i32) -> Fx {
        Fx((v as i64) << FRAC_BITS)
    }

    /// `num/den` с round-half-even. Деление на ноль насыщает по знаку числителя
    /// (параметры протокола валидируются на границе системы, не здесь).
    pub fn from_ratio(num: i64, den: i64) -> Fx {
        div_q32(num as i128, den as i128)
    }

    pub fn checked_add(self, rhs: Fx) -> Option<Fx> {
        self.0.checked_add(rhs.0).map(Fx)
    }

    pub fn checked_sub(self, rhs: Fx) -> Option<Fx> {
        self.0.checked_sub(rhs.0).map(Fx)
    }

    /// Умножение с round-half-even; `None` при переполнении Q32.32.
    pub fn checked_mul(self, rhs: Fx) -> Option<Fx> {
        let wide = shr_rhe_i128((self.0 as i128) * (rhs.0 as i128), FRAC_BITS);
        i64::try_from(wide).ok().map(Fx)
    }

    /// Деление с round-half-even; `None` при нуле в знаменателе или переполнении.
    pub fn checked_div(self, rhs: Fx) -> Option<Fx> {
        if rhs.0 == 0 {
            return None;
        }
        let n = (self.0 as i128) << FRAC_BITS;
        i64::try_from(div_rhe_i128(n, rhs.0 as i128)).ok().map(Fx)
    }

    /// Модуль с насыщением (`|MIN|` → `MAX`).
    pub fn abs(self) -> Fx {
        Fx(self.0.saturating_abs())
    }

    /// `2^self` с насыщением: результат ≥ `2³¹` → `MAX`; исчезающе малый → `0`.
    ///
    /// Нормативная аппроксимация: `x = n + f` (целая и дробная части, `f ∈ [0, 1)`),
    /// `2^f` — линейная интерполяция по [`EXP2_TABLE_Q32`] (старшие 8 бит `f` — индекс,
    /// младшие 24 — вес интерполяции), затем сдвиг на `n` с round-half-even.
    pub fn exp2(self) -> Fx {
        // 2^31 * 2^32 = 2^63 > i64::MAX: всё, что ≥ 31, насыщает.
        if self.0 >= (31i64 << FRAC_BITS) {
            return Fx::MAX;
        }
        // 2^(-33) в Q32.32 = 0.5 ulp: всё, что ≤ -65, гарантированно нулится
        // (запас на два порядка ниже фактического порога — ветка только страхует сдвиги).
        if self.0 <= -(65i64 << FRAC_BITS) {
            return Fx::ZERO;
        }
        let n = self.0 >> FRAC_BITS; // floor, [-65, 30]
        let f = (self.0 & FRAC_MASK) as u64; // дробная часть, [0, 2^32)
        let idx = (f >> 24) as usize; // 0..=255
        let rem = (f & 0x00FF_FFFF) as u128; // 24 бита
        let t0 = EXP2_TABLE_Q32[idx] as u128;
        let t1 = EXP2_TABLE_Q32[idx + 1] as u128;
        // Значение 2^f в Q32.32, f ∈ [0,1) → результат ∈ [2^32, 2^33].
        let y = shr_rhe_u128((t0 << 24) + (t1 - t0) * rem, 24);
        let bits = if n >= 0 {
            // n ≤ 30, y ≤ 2^33 → y << n < 2^63: в i64 помещается всегда.
            (y << n) as i64
        } else {
            let shift = (-n) as u32; // ≤ 65 < 128
            shr_rhe_u128(y, shift) as i64
        };
        Fx(bits)
    }

    /// `log2(self)`; `None` при `self ≤ 0`.
    ///
    /// Нормативная аппроксимация: мантисса нормируется в `[1, 2)` (Q2.62),
    /// 32 дробных бита извлекаются поразрядно возведением в квадрат.
    pub fn log2(self) -> Option<Fx> {
        if self.0 <= 0 {
            return None;
        }
        let bits = self.0 as u64;
        let msb = 63 - bits.leading_zeros(); // ≤ 62 (bits < 2^63)
        let int_part = msb as i64 - FRAC_BITS as i64; // [-32, 30]
        let mut m: u128 = (bits as u128) << (62 - msb); // мантисса Q2.62 в [1, 2)
        let two_q62: u128 = 2 << 62;
        let mut frac: u64 = 0;
        for _ in 0..FRAC_BITS {
            m = shr_rhe_u128(m * m, 62); // квадрат: [1, 4) в Q2.62
            frac <<= 1;
            if m >= two_q62 {
                frac |= 1;
                m = shr_rhe_u128(m, 1);
            }
        }
        Some(Fx((int_part << FRAC_BITS) + frac as i64))
    }

    /// `√self` (floor до ulp Q32.32); `None` при `self < 0`.
    pub fn sqrt(self) -> Option<Fx> {
        if self.0 < 0 {
            return None;
        }
        // sqrt(v / 2^32) * 2^32 = sqrt(v * 2^32); v < 2^63 → аргумент < 2^95.
        Some(Fx(isqrt_u128((self.0 as u128) << FRAC_BITS) as i64))
    }

    /// Насыщающая версия деления (`/ 0` → `MAX`/`MIN`/`0` по знаку числителя).
    fn div_saturating(self, rhs: Fx) -> Fx {
        // Битовая форма деления совпадает с from_ratio: (a·2³²)/b при b ≠ 0.
        div_q32(self.0 as i128, rhs.0 as i128)
    }
}

impl core::ops::Add for Fx {
    type Output = Fx;
    /// Насыщающее сложение.
    fn add(self, rhs: Fx) -> Fx {
        Fx(self.0.saturating_add(rhs.0))
    }
}

impl core::ops::Sub for Fx {
    type Output = Fx;
    /// Насыщающее вычитание.
    fn sub(self, rhs: Fx) -> Fx {
        Fx(self.0.saturating_sub(rhs.0))
    }
}

impl core::ops::Mul for Fx {
    type Output = Fx;
    /// Насыщающее умножение, round-half-even.
    fn mul(self, rhs: Fx) -> Fx {
        let wide = shr_rhe_i128((self.0 as i128) * (rhs.0 as i128), FRAC_BITS);
        Fx(saturate_i64(wide))
    }
}

impl core::ops::Div for Fx {
    type Output = Fx;
    /// Насыщающее деление, round-half-even; `/ 0` насыщает по знаку числителя.
    fn div(self, rhs: Fx) -> Fx {
        self.div_saturating(rhs)
    }
}

impl core::ops::Neg for Fx {
    type Output = Fx;
    /// Насыщающее отрицание (`-MIN` → `MAX`).
    fn neg(self) -> Fx {
        Fx(self.0.saturating_neg())
    }
}

fn saturate_i64(v: i128) -> i64 {
    if v > i64::MAX as i128 {
        i64::MAX
    } else if v < i64::MIN as i128 {
        i64::MIN
    } else {
        v as i64
    }
}

/// `num / den` → Q32.32 c round-half-even и насыщением (для `from_ratio`).
fn div_q32(num: i128, den: i128) -> Fx {
    if den == 0 {
        return match num.signum() {
            1 => Fx::MAX,
            -1 => Fx::MIN,
            _ => Fx::ZERO,
        };
    }
    Fx(saturate_i64(div_rhe_i128(num << FRAC_BITS, den)))
}

/// Деление i128 с округлением round-half-even (к ближайшему, ничья — к чётному).
fn div_rhe_i128(n: i128, d: i128) -> i128 {
    let q = n.div_euclid(d);
    let r = n.rem_euclid(d); // 0 ≤ r < |d|
    let d_abs = d.unsigned_abs();
    let twice = (r as u128) * 2;
    // floor (div_euclid) + шаг к ближайшему — направление шага всегда +1,
    // потому что остаток эвклидова деления неотрицателен.
    if twice > d_abs || (twice == d_abs && q & 1 == 1) {
        q + 1
    } else {
        q
    }
}

/// Правый сдвиг i128 с round-half-even (арифметический floor + коррекция).
fn shr_rhe_i128(x: i128, s: u32) -> i128 {
    let q = x >> s;
    let r = (x as u128) & ((1u128 << s) - 1); // младшие биты совпадают в two's complement
    let half = 1u128 << (s - 1);
    if r > half || (r == half && q & 1 == 1) {
        q + 1
    } else {
        q
    }
}

/// Правый сдвиг u128 с round-half-even.
const fn shr_rhe_u128(x: u128, s: u32) -> u128 {
    if s >= 128 {
        return 0;
    }
    let q = x >> s;
    let r = x & ((1u128 << s) - 1);
    let half = 1u128 << (s - 1);
    if r > half || (r == half && q & 1 == 1) {
        q + 1
    } else {
        q
    }
}

/// Целочисленный floor-корень u128 (поразрядный, детерминированный).
const fn isqrt_u128(n: u128) -> u128 {
    if n == 0 {
        return 0;
    }
    let mut x = n;
    let mut c: u128 = 0;
    let mut d: u128 = 1 << 126;
    while d > n {
        d >>= 2;
    }
    while d != 0 {
        if x >= c + d {
            x -= c + d;
            c = (c >> 1) + d;
        } else {
            c >>= 1;
        }
        d >>= 2;
    }
    c
}

/// `√n` для целого `n` (например, `N_d` активных участников домена) в Q32.32.
///
/// Используется для капа насыщения делегаций `C_d = max(20, 2·√N_d)` (FGP §4.5).
/// Floor до ulp; `n ≥ 2⁶²` насыщает (población такого размера не существует).
pub fn int_sqrt_q32(n: u64) -> Fx {
    if n >= 1 << 62 {
        return Fx::MAX;
    }
    // sqrt(n) * 2^32 = sqrt(n * 2^64); n < 2^62 → аргумент < 2^126.
    Fx::from_bits(isqrt_u128((n as u128) << 64) as i64)
}

/// Таблица `2^(i/256)` в Q32.32, `i = 0..=256` (257 узлов, 256 интервалов интерполяции).
///
/// Строится в compile-time целочисленным алгоритмом: корни `2^(1/2^k)` получаются
/// повторным целочисленным isqrt в Q2.62, узлы — произведения корней по битам индекса.
/// Ни одной float-операции — таблица бит-в-бит одинакова на всех платформах и
/// зафиксирована вектором `governance-fx-exp2-table-v1.json`. Изменение = R3
/// (FGP-CRYPTO §10, Приложение A).
pub const EXP2_TABLE_Q32: [u64; 257] = build_exp2_table();

const fn build_exp2_table() -> [u64; 257] {
    // roots[k] = 2^(1/2^k) в Q2.62: roots[0] = 2, дальше — последовательные корни.
    let mut roots = [0u128; 9];
    roots[0] = 2 << 62;
    let mut k = 1;
    while k <= 8 {
        // sqrt в Q2.62: sqrt(v / 2^62) * 2^62 = sqrt(v * 2^62); v ≤ 2^63 → аргумент ≤ 2^125.
        roots[k] = isqrt_u128(roots[k - 1] << 62);
        k += 1;
    }
    let mut table = [0u64; 257];
    let mut i = 0;
    while i <= 256 {
        // 2^(i/256) = Π roots[8-j] по установленным битам j индекса i (i ≤ 2^8).
        let mut acc: u128 = 1 << 62;
        let mut j = 0;
        while j <= 8 {
            if i & (1 << j) != 0 {
                acc = shr_rhe_u128(acc * roots[8 - j], 62);
            }
            j += 1;
        }
        // Q2.62 → Q32.32.
        table[i] = shr_rhe_u128(acc, 30) as u64;
        i += 1;
    }
    table
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fx(int: i32) -> Fx {
        Fx::from_int(int)
    }

    #[test]
    fn table_endpoints_are_exact() {
        assert_eq!(EXP2_TABLE_Q32[0], 1 << 32);
        assert_eq!(EXP2_TABLE_Q32[256], 2 << 32);
        // Середина: 2^0.5 = sqrt(2) ≈ 1.41421356 → Q32.32 ≈ 6074000999.95.
        assert_eq!(EXP2_TABLE_Q32[128], 6_074_001_000);
        // Монотонность строгая.
        for i in 0..256 {
            assert!(EXP2_TABLE_Q32[i] < EXP2_TABLE_Q32[i + 1]);
        }
    }

    #[test]
    fn exp2_exact_powers() {
        assert_eq!(fx(0).exp2(), Fx::ONE);
        assert_eq!(fx(1).exp2(), Fx::TWO);
        assert_eq!(fx(10).exp2(), fx(1024));
        assert_eq!(fx(-1).exp2(), Fx::from_ratio(1, 2));
        assert_eq!(fx(-2).exp2(), Fx::from_ratio(1, 4));
        assert_eq!(fx(31).exp2(), Fx::MAX);
        assert_eq!(fx(100).exp2(), Fx::MAX);
        assert_eq!(fx(-100).exp2(), Fx::ZERO);
    }

    #[test]
    fn exp2_half_matches_sqrt2() {
        // 2^0.5 попадает точно в узел 128 таблицы.
        assert_eq!(Fx::from_ratio(1, 2).exp2().to_bits(), 6_074_001_000);
    }

    #[test]
    fn log2_exact_powers() {
        assert_eq!(Fx::ONE.log2(), Some(Fx::ZERO));
        assert_eq!(Fx::TWO.log2(), Some(Fx::ONE));
        assert_eq!(fx(1024).log2(), Some(fx(10)));
        assert_eq!(Fx::from_ratio(1, 2).log2(), Some(fx(-1)));
        assert_eq!(Fx::ZERO.log2(), None);
        assert_eq!(fx(-3).log2(), None);
    }

    #[test]
    fn log2_exp2_roundtrip_within_tolerance() {
        // На сетке x ∈ [-10, 20] с шагом 0.37: |log2(exp2(x)) - x| ≤ 2^-18.
        // Глубже -10 доминирует квантование самого exp2 (мало значащих битов),
        // относительная точность там проверяется value-domain циклом ниже.
        let step = Fx::from_ratio(37, 100);
        let tol = 1i64 << (FRAC_BITS - 18);
        let mut x = fx(-10);
        while x <= fx(20) {
            let y = x.exp2().log2().expect("exp2 > 0");
            assert!(
                (y.to_bits() - x.to_bits()).abs() <= tol,
                "roundtrip x={:?} y={:?}",
                x,
                y
            );
            x = x + step;
        }
    }

    #[test]
    fn exp2_log2_value_roundtrip() {
        // v от ~2^-9 до ~2^20: |exp2(log2(v)) - v| ≤ v·2^-18 + 2 ulp.
        let mut v: i64 = 1 << 23;
        while v < (1i64 << 52) {
            let val = Fx::from_bits(v);
            let rt = val.log2().unwrap().exp2();
            let tol = (v >> 18) + 2;
            assert!((rt.to_bits() - v).abs() <= tol, "v={v} rt={}", rt.to_bits());
            v = v.saturating_mul(7) / 4;
        }
    }

    #[test]
    fn mul_rounds_half_to_even() {
        // 0.5 ulp * 0.5 ulp даёт ничью на сдвиге: 1*2^-32 * 1*2^-32... возьмём явные случаи.
        // a = 1.5 ulp (bits=3), b = 0.5 (bits=2^31): произведение = 3*2^31 = 1.5 ulp → к чётному 2.
        let a = Fx::from_bits(3);
        let b = Fx::from_ratio(1, 2);
        assert_eq!((a * b).to_bits(), 2);
        // bits=1: 0.5 ulp → к чётному 0.
        let c = Fx::from_bits(1);
        assert_eq!((c * b).to_bits(), 0);
    }

    #[test]
    fn div_rounds_half_to_even() {
        // 1 / 2^32 ulp-масштаб: from_ratio(1, 3) обычное; ничьи:
        assert_eq!(
            Fx::from_bits(1).checked_div(Fx::TWO),
            Some(Fx::from_bits(0))
        );
        assert_eq!(
            Fx::from_bits(3).checked_div(Fx::TWO),
            Some(Fx::from_bits(2))
        );
        assert_eq!(
            Fx::from_bits(-1).checked_div(Fx::TWO),
            Some(Fx::from_bits(0))
        );
        assert_eq!(
            Fx::from_bits(-3).checked_div(Fx::TWO),
            Some(Fx::from_bits(-2))
        );
    }

    #[test]
    fn saturating_semantics() {
        assert_eq!(Fx::MAX + Fx::ONE, Fx::MAX);
        assert_eq!(Fx::MIN - Fx::ONE, Fx::MIN);
        assert_eq!(fx(1 << 20) * fx(1 << 20), Fx::MAX);
        assert_eq!(fx(-(1 << 20)) * fx(1 << 20), Fx::MIN);
        assert_eq!(fx(5) / Fx::ZERO, Fx::MAX);
        assert_eq!(fx(-5) / Fx::ZERO, Fx::MIN);
        assert_eq!(Fx::ZERO / Fx::ZERO, Fx::ZERO);
        assert_eq!(-Fx::MIN, Fx::MAX);
        assert_eq!(Fx::MIN.abs(), Fx::MAX);
        // 2·2³⁰ = 2³¹ — ровно на единицу за пределом Q32.32.
        assert_eq!(fx(2).checked_mul(fx(1 << 30)), None);
        assert_eq!(fx(20).checked_mul(fx(1 << 26)), Some(fx(20 << 26)));
        assert_eq!(Fx::ONE.checked_div(Fx::ZERO), None);
    }

    #[test]
    fn sqrt_basics() {
        assert_eq!(fx(0).sqrt(), Some(Fx::ZERO));
        assert_eq!(fx(4).sqrt(), Some(fx(2)));
        assert_eq!(fx(9).sqrt(), Some(fx(3)));
        assert_eq!(fx(-1).sqrt(), None);
        // sqrt(2) — floor до ulp того же значения, что узел таблицы (±1 ulp).
        let s = fx(2).sqrt().unwrap().to_bits();
        assert!((s - 6_074_001_000).abs() <= 1, "sqrt(2) = {s}");
    }

    #[test]
    fn int_sqrt_matches_perfect_squares() {
        assert_eq!(int_sqrt_q32(0), Fx::ZERO);
        assert_eq!(int_sqrt_q32(1), Fx::ONE);
        assert_eq!(int_sqrt_q32(10_000), Fx::from_int(100));
        assert_eq!(int_sqrt_q32(1_000_000), Fx::from_int(1000));
    }

    #[test]
    fn from_ratio_basics() {
        assert_eq!(Fx::from_ratio(1, 1), Fx::ONE);
        assert_eq!(Fx::from_ratio(3, 2).to_bits(), 3 << 31);
        assert_eq!(Fx::from_ratio(-3, 2).to_bits(), -(3 << 31));
        assert_eq!(Fx::from_ratio(1, 0), Fx::MAX);
        assert_eq!(Fx::from_ratio(-1, 0), Fx::MIN);
        assert_eq!(Fx::from_ratio(0, 0), Fx::ZERO);
    }
}
