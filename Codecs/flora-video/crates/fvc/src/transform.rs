//! Целочисленные DCT-преобразования 4/8/16/32 (нормативные).
//!
//! Матрицы `DCT{N}` (tables.rs) — целочисленное приближение `2^(13−log₂N)·√N · O`,
//! где `O` — ортонормальная DCT-II (масштаб обратен размеру: N·max|T| ≈ 2¹³·√2 —
//! константа). Сдвиги подобраны так, что **домен коэффициентов равен
//! 8 × ортонормальному**: шаг квантования 8 ≈ 1 ортонормальная единица, одна
//! таблица шагов на все размеры.
//!
//! Прямое: C = (T·X·Tᵗ) >> (23 − log₂N); обратное: X = (Tᵗ·C·T) >> (29 − log₂N).
//!
//! Аккумуляция обеих стадий в i64 **без промежуточного округления** — единственный
//! `(v + 2^(s-1)) >> s` в конце. Переполнение исключено: (N·max|T|)² ≈ 2²⁷,
//! вход обратного клампирован `COEFF_CLAMP` (2¹⁷) → |acc| < 2⁴⁴ ≪ i64.
//! Детерминировано на всех платформах.

use crate::tables::{DCT4, DCT8, DCT16, DCT32};

/// Кламп дезквантованных коэффициентов (нормативный): защищает обратное
/// преобразование от переполнения на повреждённых потоках.
pub const COEFF_CLAMP: i32 = 131_071;

/// Кламп восстановленного остатка до сложения с предсказанием (нормативный).
pub const RESIDUAL_CLAMP: i32 = 2_047;

#[inline]
fn round_shift(v: i64, s: u32) -> i64 {
    (v + (1i64 << (s - 1))) >> s
}

#[inline]
fn row(n: usize, m: usize) -> &'static [i32] {
    match n {
        4 => &DCT4[m],
        8 => &DCT8[m],
        16 => &DCT16[m],
        _ => &DCT32[m],
    }
}

/// Прямое 2D-преобразование `n×n` (используется только энкодером, но целочисленное —
/// для детерминизма). `input` и `output` — raster-буферы длиной n².
pub fn forward(input: &[i32], n: usize, output: &mut [i32]) {
    debug_assert!(matches!(n, 4 | 8 | 16 | 32));
    let shift = 23 - n.trailing_zeros();

    let mut tmp = [0i64; 32 * 32];
    // Стадия 1: строки. A[i][k] = Σ_j X[i][j]·T[k][j] (без округления)
    for i in 0..n {
        for k in 0..n {
            let t = row(n, k);
            let mut acc = 0i64;
            for j in 0..n {
                acc += i64::from(input[i * n + j]) * i64::from(t[j]);
            }
            tmp[i * n + k] = acc;
        }
    }
    // Стадия 2: столбцы. C[k][l] = (Σ_i T[k][i]·A[i][l]) >> shift
    for k in 0..n {
        let t = row(n, k);
        for l in 0..n {
            let mut acc = 0i64;
            for i in 0..n {
                acc += i64::from(t[i]) * tmp[i * n + l];
            }
            output[k * n + l] = round_shift(acc, shift) as i32;
        }
    }
}

/// Обратное 2D-преобразование `n×n` (нормативное). Вход — дезквантованные
/// коэффициенты (кламп `COEFF_CLAMP`), выход — остаток (кламп `RESIDUAL_CLAMP`).
pub fn inverse(coeffs: &[i32], n: usize, output: &mut [i32]) {
    debug_assert!(matches!(n, 4 | 8 | 16 | 32));
    let shift = 29 - n.trailing_zeros();

    let mut tmp = [0i64; 32 * 32];
    // Стадия 1: A[i][l] = Σ_k T[k][i]·C[k][l] (без округления)
    for i in 0..n {
        for l in 0..n {
            let mut acc = 0i64;
            for k in 0..n {
                acc += i64::from(row(n, k)[i]) * i64::from(coeffs[k * n + l]);
            }
            tmp[i * n + l] = acc;
        }
    }
    // Стадия 2: X[i][j] = (Σ_l A[i][l]·T[l][j]) >> shift
    for i in 0..n {
        for j in 0..n {
            let mut acc = 0i64;
            for l in 0..n {
                acc += tmp[i * n + l] * i64::from(row(n, l)[j]);
            }
            let v = round_shift(acc, shift) as i32;
            output[i * n + j] = v.clamp(-RESIDUAL_CLAMP, RESIDUAL_CLAMP);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u32 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (self.0 >> 33) as u32
        }
        fn residual(&mut self) -> i32 {
            (self.next() % 511) as i32 - 255
        }
    }

    /// Прямое+обратное без квантования восстанавливает вход с точностью ≤2 LSB
    /// (погрешность целочисленной матрицы; заведомо ниже шума квантования).
    #[test]
    fn forward_inverse_roundtrip() {
        let mut rng = Lcg(7);
        for &n in &[4usize, 8, 16, 32] {
            let mut total_err = 0u64;
            let mut count = 0u64;
            for _ in 0..50 {
                let input: Vec<i32> = (0..n * n).map(|_| rng.residual()).collect();
                let mut coeffs = vec![0i32; n * n];
                let mut recon = vec![0i32; n * n];
                forward(&input, n, &mut coeffs);
                inverse(&coeffs, n, &mut recon);
                for i in 0..n * n {
                    let err = (input[i] - recon[i]).unsigned_abs() as u64;
                    assert!(err <= 2, "n={n} pos={i} in={} out={}", input[i], recon[i]);
                    total_err += err;
                    count += 1;
                }
            }
            // Средняя ошибка на случайных остатках — доли LSB.
            assert!(
                total_err * 4 < count,
                "n={n}: mean error {} too high",
                total_err as f64 / count as f64
            );
        }
    }

    /// Масштаб домена: плоский блок r даёт DC ≈ 8·N·r (домен = 8×ортонормальный).
    #[test]
    fn coefficient_domain_scale() {
        for &n in &[4usize, 8, 16, 32] {
            let input = vec![100i32; n * n];
            let mut coeffs = vec![0i32; n * n];
            forward(&input, n, &mut coeffs);
            let expected = 8 * n as i32 * 100;
            let dc = coeffs[0];
            let err = (dc - expected).abs();
            assert!(
                err * 100 <= expected * 2,
                "n={n}: dc={dc}, expected≈{expected}"
            );
            // AC при плоском входе почти нулевые.
            for (i, &c) in coeffs.iter().enumerate().skip(1) {
                assert!(c.abs() <= 8, "n={n} ac[{i}]={c}");
            }
        }
    }

    /// Обратное преобразование не переполняется на экстремальных (повреждённых) входах.
    #[test]
    fn inverse_extreme_input_safe() {
        for &n in &[4usize, 8, 16, 32] {
            let coeffs = vec![COEFF_CLAMP; n * n];
            let mut out = vec![0i32; n * n];
            inverse(&coeffs, n, &mut out);
            for &v in &out {
                assert!(v.abs() <= RESIDUAL_CLAMP);
            }
        }
    }
}
