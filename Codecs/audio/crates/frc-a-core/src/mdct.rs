//! MDCT/iMDCT c низкоперекрывающимся окном и 50% overlap-add по hop'у
//! (FRC-A.md, «Нормативные формулы»).
//!
//! Окно (CELT-подход): носитель `N + L` по центру формального 2N-окна — нули по
//! `s = (N − L)/2` с краёв, подъём/спад Vorbis-формы длиной `L`, единицы между.
//! При `L = N` вырождается в классическое полноперекрывающееся окно Vorbis.
//! Благодаря общей длине склейки `L` длинные и короткие кадры стыкуются без
//! переходных окон (TDAC-пары «спад‑подъём» всегда одной формы).
//!
//! Реализация через TDA-fold (2N → N) + DCT-IV размера N — математически
//! тождественна прямой формуле спецификации (проверяется тестом против
//! наивной реализации). Быстрый FFT-путь для DCT-IV — v0.3 (Roadmap): fold
//! останется, заменится только матричное DCT-IV.

use core::f64::consts::{FRAC_PI_2, PI};

/// Нормативное окно: длина `2n`, носитель `n + l` по центру.
pub(crate) fn low_overlap_window(n: usize, l: usize) -> Vec<f64> {
    assert!(l > 0 && l <= n && (n - l).is_multiple_of(2));
    let two_n = 2 * n;
    let s = (n - l) / 2;
    let rise = |i: usize| {
        let inner = (PI * (i as f64 + 0.5) / (2 * l) as f64).sin();
        (FRAC_PI_2 * inner * inner).sin()
    };
    let mut w = vec![0f64; two_n];
    for i in 0..l {
        w[s + i] = rise(i);
        w[two_n - s - l + i] = rise(l - 1 - i);
    }
    for v in w.iter_mut().take(two_n - s - l).skip(s + l) {
        *v = 1.0;
    }
    w
}

pub struct Mdct {
    n: usize,
    window: Vec<f64>,
    /// Симметричная матрица DCT-IV: `dct4[k * n + m] = cos(π/n · (m + 0.5) · (k + 0.5))`.
    dct4: Vec<f64>,
}

impl Mdct {
    /// `n` — hop (число коэффициентов), `overlap` — длина склейки `L`.
    pub fn new(n: usize, overlap: usize) -> Self {
        assert!(
            n > 0 && n.is_multiple_of(2),
            "MDCT size must be positive and even"
        );
        let window = low_overlap_window(n, overlap);
        let mut dct4 = vec![0f64; n * n];
        for k in 0..n {
            let row = &mut dct4[k * n..(k + 1) * n];
            for (m, t) in row.iter_mut().enumerate() {
                *t = (PI / n as f64 * (m as f64 + 0.5) * (k as f64 + 0.5)).cos();
            }
        }
        Self { n, window, dct4 }
    }

    pub fn n(&self) -> usize {
        self.n
    }

    /// TDA-fold windowed-входа: 2N сэмплов → N значений так, что
    /// `MDCT(x) = DCT-IV(fold(w·x))`. Выведено из тождеств
    /// `cos(θ + 2π(k+0.5)) = −cos θ` и чётности косинуса:
    /// `t[m] = −v[3N/2−1−m] − v[3N/2+m]` для `m < N/2`,
    /// `t[m] =  v[m−N/2]   − v[3N/2−1−m]` для `m ≥ N/2`, где `v = w·x`.
    fn fold(&self, x: &[f32], t: &mut [f64]) {
        let n = self.n;
        let h = n / 2;
        let v = |i: usize| f64::from(x[i]) * self.window[i];
        for (m, out) in t.iter_mut().enumerate() {
            *out = if m < h {
                -v(3 * h - 1 - m) - v(3 * h + m)
            } else {
                v(m - h) - v(3 * h - 1 - m)
            };
        }
    }

    /// `x` — 2N сэмплов (окно применяется внутри), `out` — N коэффициентов.
    pub fn forward(&self, x: &[f32], out: &mut [f32]) {
        assert_eq!(x.len(), 2 * self.n);
        assert_eq!(out.len(), self.n);
        let mut t = vec![0f64; self.n];
        self.fold(x, &mut t);
        for (k, o) in out.iter_mut().enumerate() {
            let row = &self.dct4[k * self.n..(k + 1) * self.n];
            let acc: f64 = row.iter().zip(&t).map(|(&c, &v)| c * v).sum();
            *o = acc as f32;
        }
    }

    /// `coeffs` — N коэффициентов, `out` — 2N windowed-сэмплов для overlap-add.
    pub fn inverse(&self, coeffs: &[f32], out: &mut [f32]) {
        let n = self.n;
        assert_eq!(coeffs.len(), n);
        assert_eq!(out.len(), 2 * n);
        // d = DCT-IV(coeffs); матрица симметрична, поэтому строки те же.
        let mut d = vec![0f64; n];
        for (k, &c) in coeffs.iter().enumerate() {
            if c == 0.0 {
                continue;
            }
            let c = f64::from(c);
            let row = &self.dct4[k * n..(k + 1) * n];
            for (acc, &t) in d.iter_mut().zip(row) {
                *acc += c * t;
            }
        }
        // Unfold — транспонирование fold'а, затем окно и масштаб 2/N.
        let h = n / 2;
        let scale = 2.0 / n as f64;
        for (i, o) in out.iter_mut().enumerate() {
            let pre = if i < h {
                d[i + h]
            } else if i < 3 * h {
                -d[3 * h - 1 - i]
            } else {
                -d[i - 3 * h]
            };
            *o = (scale * self.window[i] * pre) as f32;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xorshift(state: &mut u32) -> f32 {
        *state ^= *state << 13;
        *state ^= *state >> 17;
        *state ^= *state << 5;
        (*state as f32 / 2f32.powi(31)) - 1.0
    }

    /// Прямая реализация нормативных формул FRC-A.md — эталон для fold-версии.
    struct NaiveMdct {
        n: usize,
        window: Vec<f64>,
    }

    impl NaiveMdct {
        fn new(n: usize, overlap: usize) -> Self {
            Self {
                n,
                window: low_overlap_window(n, overlap),
            }
        }

        fn arg(&self, j: usize, k: usize) -> f64 {
            PI / self.n as f64 * (j as f64 + 0.5 + self.n as f64 / 2.0) * (k as f64 + 0.5)
        }

        fn forward(&self, x: &[f32], out: &mut [f32]) {
            for (k, o) in out.iter_mut().enumerate() {
                let acc: f64 = (0..2 * self.n)
                    .map(|j| f64::from(x[j]) * self.window[j] * self.arg(j, k).cos())
                    .sum();
                *o = acc as f32;
            }
        }

        fn inverse(&self, coeffs: &[f32], out: &mut [f32]) {
            let scale = 2.0 / self.n as f64;
            for (j, o) in out.iter_mut().enumerate() {
                let acc: f64 = coeffs
                    .iter()
                    .enumerate()
                    .map(|(k, &c)| f64::from(c) * self.arg(j, k).cos())
                    .sum();
                *o = (scale * self.window[j] * acc) as f32;
            }
        }
    }

    #[test]
    fn window_satisfies_princen_bradley() {
        for (n, l) in [(64, 64), (960, 120), (120, 120)] {
            let w = low_overlap_window(n, l);
            for i in 0..n {
                let s = w[i] * w[i] + w[i + n] * w[i + n];
                assert!((s - 1.0).abs() < 1e-12, "n={n} l={l} i={i}: {s}");
            }
            // Симметрия окна (условие TDAC).
            for i in 0..2 * n {
                assert!((w[i] - w[2 * n - 1 - i]).abs() < 1e-12);
            }
        }
    }

    #[test]
    fn fold_matches_naive_normative_formula() {
        for (n, l) in [(32usize, 32usize), (480, 120), (960, 120), (120, 120)] {
            let fast = Mdct::new(n, l);
            let naive = NaiveMdct::new(n, l);
            let mut state = 0xF01D_1234u32;
            let x: Vec<f32> = (0..2 * n).map(|_| xorshift(&mut state)).collect();
            let coeffs: Vec<f32> = (0..n).map(|_| xorshift(&mut state)).collect();

            let mut a = vec![0f32; n];
            let mut b = vec![0f32; n];
            fast.forward(&x, &mut a);
            naive.forward(&x, &mut b);
            for (i, (&fa, &na)) in a.iter().zip(&b).enumerate() {
                assert!((fa - na).abs() < 1e-3, "n={n} fwd[{i}]: {fa} vs {na}");
            }

            let mut ya = vec![0f32; 2 * n];
            let mut yb = vec![0f32; 2 * n];
            fast.inverse(&coeffs, &mut ya);
            naive.inverse(&coeffs, &mut yb);
            for (i, (&fa, &na)) in ya.iter().zip(&yb).enumerate() {
                assert!((fa - na).abs() < 1e-4, "n={n} inv[{i}]: {fa} vs {na}");
            }
        }
    }

    #[test]
    fn perfect_reconstruction_via_overlap_add() {
        for (n, l) in [(32usize, 32usize), (960, 120), (120, 120)] {
            let m = Mdct::new(n, l);
            let hops = 6;
            let mut state = 0xC0FF_EE01u32;
            let x: Vec<f32> = (0..hops * n).map(|_| xorshift(&mut state)).collect();

            // Стриминг как в кодеке: prev инициализирован нулями, в конце flush-кадр.
            let mut prev = vec![0f32; n];
            let mut recon = Vec::new();
            let mut ola = vec![0f32; n];
            let mut coeffs = vec![0f32; n];
            let mut synth = vec![0f32; 2 * n];
            for h in 0..=hops {
                let cur: Vec<f32> = if h < hops {
                    x[h * n..(h + 1) * n].to_vec()
                } else {
                    vec![0f32; n]
                };
                let mut buf = prev.clone();
                buf.extend_from_slice(&cur);
                m.forward(&buf, &mut coeffs);
                prev = cur;

                m.inverse(&coeffs, &mut synth);
                for j in 0..n {
                    recon.push(ola[j] + synth[j]);
                }
                ola.copy_from_slice(&synth[n..]);
            }

            // Первые n выходных сэмплов — задержка (нулевой prev), далее — сигнал.
            for (i, &orig) in x.iter().enumerate() {
                let got = recon[n + i];
                assert!(
                    (got - orig).abs() < 1e-4,
                    "n={n} l={l}, sample {i}: {got} vs {orig}"
                );
            }
        }
    }
}
