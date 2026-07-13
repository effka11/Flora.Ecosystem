//! MDCT/iMDCT c окном Vorbis и 50% overlap-add (FAC.md, «Нормативные формулы»).
//!
//! Прямая O(N²)-реализация с предвычисленной cos-таблицей: приоритет v0 —
//! корректность и точное соответствие спецификации. Быстрый FFT-путь — v0.1
//! (Roadmap), с тестом эквивалентности против этой реализации.

use core::f64::consts::{FRAC_PI_2, PI};

pub struct Mdct {
    n: usize,
    window: Vec<f64>,
    /// `table[k * 2n + j] = cos(π/n · (j + 0.5 + n/2) · (k + 0.5))`
    table: Vec<f64>,
}

impl Mdct {
    pub fn new(n: usize) -> Self {
        assert!(n > 0 && n % 2 == 0, "MDCT size must be positive and even");
        let two_n = 2 * n;
        let window: Vec<f64> = (0..two_n)
            .map(|i| {
                let inner = (PI * (i as f64 + 0.5) / two_n as f64).sin();
                (FRAC_PI_2 * inner * inner).sin()
            })
            .collect();
        let mut table = vec![0f64; n * two_n];
        for k in 0..n {
            let row = &mut table[k * two_n..(k + 1) * two_n];
            for (j, t) in row.iter_mut().enumerate() {
                *t = (PI / n as f64 * (j as f64 + 0.5 + n as f64 / 2.0) * (k as f64 + 0.5)).cos();
            }
        }
        Self { n, window, table }
    }

    pub fn n(&self) -> usize {
        self.n
    }

    /// `x` — 2N сэмплов (окно применяется внутри), `out` — N коэффициентов.
    pub fn forward(&self, x: &[f32], out: &mut [f32]) {
        let two_n = 2 * self.n;
        assert_eq!(x.len(), two_n);
        assert_eq!(out.len(), self.n);
        let wx: Vec<f64> = x
            .iter()
            .zip(&self.window)
            .map(|(&s, &w)| f64::from(s) * w)
            .collect();
        for (k, o) in out.iter_mut().enumerate() {
            let row = &self.table[k * two_n..(k + 1) * two_n];
            let acc: f64 = row.iter().zip(&wx).map(|(&t, &v)| t * v).sum();
            *o = acc as f32;
        }
    }

    /// `coeffs` — N коэффициентов, `out` — 2N windowed-сэмплов для overlap-add.
    pub fn inverse(&self, coeffs: &[f32], out: &mut [f32]) {
        let two_n = 2 * self.n;
        assert_eq!(coeffs.len(), self.n);
        assert_eq!(out.len(), two_n);
        let mut acc = vec![0f64; two_n];
        for (k, &c) in coeffs.iter().enumerate() {
            if c == 0.0 {
                continue;
            }
            let c = f64::from(c);
            let row = &self.table[k * two_n..(k + 1) * two_n];
            for (a, &t) in acc.iter_mut().zip(row) {
                *a += c * t;
            }
        }
        let scale = 2.0 / self.n as f64;
        for ((o, &a), &w) in out.iter_mut().zip(&acc).zip(&self.window) {
            *o = (scale * w * a) as f32;
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

    #[test]
    fn window_is_power_complementary() {
        let m = Mdct::new(64);
        for i in 0..64 {
            let s = m.window[i] * m.window[i] + m.window[i + 64] * m.window[i + 64];
            assert!((s - 1.0).abs() < 1e-12, "i={i}: {s}");
        }
    }

    #[test]
    fn perfect_reconstruction_via_overlap_add() {
        for n in [32usize, 960] {
            let m = Mdct::new(n);
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
                    "n={n}, sample {i}: {got} vs {orig}"
                );
            }
        }
    }
}
