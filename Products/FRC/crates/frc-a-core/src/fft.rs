//! Комплексный FFT смешанного радикса {2, 3, 5} — быстрый путь DCT-IV (`mdct`).
//!
//! Классический Кули–Тьюки (decimation in time): размер раскладывается на
//! простые радиксы 2/3/5, поддеревья пишут в непересекающиеся срезы выхода,
//! комбинация каждой колонки идёт через локальный буфер из ≤ 5 значений —
//! рекурсия без аллокаций. Твиддлы всех уровней берутся из одной таблицы
//! верхнего размера (`w_n^k = w_top^{k·top/n}`).
//!
//! Реализация ненормативна: битстрим определяют формулы MDCT (`FRC-A.md`,
//! «Нормативные формулы»), FFT — лишь способ их вычисления; тождественность
//! проверяется тестами `mdct` против наивной DCT-IV.

use core::f64::consts::PI;

/// Комплексное число f64 (минимум, нужный FFT; без внешних зависимостей).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct C64 {
    pub re: f64,
    pub im: f64,
}

impl C64 {
    pub fn new(re: f64, im: f64) -> Self {
        Self { re, im }
    }

    /// `e^{iθ}`.
    pub fn cis(theta: f64) -> Self {
        Self::new(theta.cos(), theta.sin())
    }

    pub fn add(self, o: Self) -> Self {
        Self::new(self.re + o.re, self.im + o.im)
    }

    pub fn mul(self, o: Self) -> Self {
        Self::new(
            self.re * o.re - self.im * o.im,
            self.re * o.im + self.im * o.re,
        )
    }
}

/// Радиксы в порядке выбора; больший первым — меньше уровней рекурсии.
const RADICES: [usize; 3] = [5, 3, 2];

pub(crate) struct Fft {
    n: usize,
    /// `twiddle[j] = e^{−2πi·j/n}`.
    twiddle: Vec<C64>,
}

impl Fft {
    /// `n` обязан быть вида `2^a·3^b·5^c` (все размеры FRC-A такие).
    pub fn new(n: usize) -> Self {
        assert!(n >= 1 && is_235_smooth(n), "FFT size must be 2^a*3^b*5^c");
        let twiddle = (0..n)
            .map(|j| C64::cis(-2.0 * PI * j as f64 / n as f64))
            .collect();
        Self { n, twiddle }
    }

    /// DFT: `out[k] = Σ_t inp[t]·e^{−2πi·tk/n}`.
    pub fn forward(&self, inp: &[C64], out: &mut [C64]) {
        assert_eq!(inp.len(), self.n);
        assert_eq!(out.len(), self.n);
        self.recurse(inp, 1, out, self.n);
    }

    /// Узел рекурсии: вход — арифметическая подвыборка (`inp[t·stride]`),
    /// выход — плотный срез длины `n`.
    fn recurse(&self, inp: &[C64], stride: usize, out: &mut [C64], n: usize) {
        if n == 1 {
            out[0] = inp[0];
            return;
        }
        let r = RADICES
            .into_iter()
            .find(|r| n.is_multiple_of(*r))
            .expect("size is 2/3/5-smooth");
        let l = n / r;
        for j in 0..r {
            self.recurse(&inp[j * stride..], stride * r, &mut out[j * l..][..l], l);
        }
        // X[q + s·l] = Σ_j (Y_j[q]·w_n^{jq})·w_r^{js}; w берутся из таблицы
        // верхнего уровня с шагом top/n. Чтение и запись колонки q трогают
        // один и тот же набор индексов {q + m·l} — комбинация in-place.
        let tw_stride = self.n / n;
        let mut col = [C64::default(); 5];
        for q in 0..l {
            for j in 0..r {
                col[j] = out[j * l + q].mul(self.twiddle[(j * q * tw_stride) % self.n]);
            }
            for s in 0..r {
                let mut acc = col[0];
                for j in 1..r {
                    acc = acc.add(col[j].mul(self.twiddle[(j * s * l * tw_stride) % self.n]));
                }
                out[q + s * l] = acc;
            }
        }
    }
}

fn is_235_smooth(mut n: usize) -> bool {
    for r in RADICES {
        while n.is_multiple_of(r) {
            n /= r;
        }
    }
    n == 1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xorshift(state: &mut u32) -> f64 {
        *state ^= *state << 13;
        *state ^= *state >> 17;
        *state ^= *state << 5;
        f64::from(*state) / 2f64.powi(31) - 1.0
    }

    fn naive_dft(inp: &[C64]) -> Vec<C64> {
        let n = inp.len();
        (0..n)
            .map(|k| {
                let mut acc = C64::default();
                for (t, &v) in inp.iter().enumerate() {
                    acc = acc.add(v.mul(C64::cis(-2.0 * PI * (t * k % n) as f64 / n as f64)));
                }
                acc
            })
            .collect()
    }

    #[test]
    fn matches_naive_dft_on_all_smooth_sizes() {
        let mut state = 0xFF7_0001u32;
        for n in [
            1usize, 2, 3, 4, 5, 6, 8, 9, 10, 12, 15, 16, 25, 30, 60, 240, 480,
        ] {
            let fft = Fft::new(n);
            let inp: Vec<C64> = (0..n)
                .map(|_| C64::new(xorshift(&mut state), xorshift(&mut state)))
                .collect();
            let mut out = vec![C64::default(); n];
            fft.forward(&inp, &mut out);
            let want = naive_dft(&inp);
            for (k, (got, exp)) in out.iter().zip(&want).enumerate() {
                assert!(
                    (got.re - exp.re).abs() < 1e-9 && (got.im - exp.im).abs() < 1e-9,
                    "n={n} k={k}: got ({}, {}), want ({}, {})",
                    got.re,
                    got.im,
                    exp.re,
                    exp.im
                );
            }
        }
    }

    #[test]
    #[should_panic(expected = "2^a*3^b*5^c")]
    fn rejects_non_smooth_size() {
        let _ = Fft::new(7);
    }
}
