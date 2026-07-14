//! Трансформа кадра (FRC-A.md, «Codec overview»): длинный режим — одна MDCT
//! `N = 960` с перекрытием `L = 120`; транзиентный — 8 коротких MDCT `N/8`
//! с тем же перекрытием, коэффициенты интерливятся `X[f·8 + j]`.
//!
//! Общая длина склейки `L` делает длинные и короткие кадры совместимыми по
//! TDAC без переходных окон: спад любого кадра встречает подъём той же формы.
//! Носитель окна кадра — `[s, 2N − s)`, `s = (N − L)/2`; короткий блок `j`
//! занимает `[s + j·N/8, s + j·N/8 + N/4)` — блоки тайлят носитель точно.
//!
//! Края полос (`bands.rs`) кратны 8, поэтому в интерливинг-домене полоса `b`
//! покрывает те же индексы `[edges[b], edges[b+1])`, что и в длинном режиме —
//! весь пайплайн энергий/аллокации/формы не зависит от режима кадра.

use crate::mdct::Mdct;

/// Шаг кадра в сэмплах (20 мс @ 48 кГц); окно MDCT — `2 * FRAME_N`.
pub const FRAME_N: usize = 960;

/// Длина склейки окон (2.5 мс @ 48 кГц) — общая для длинных и коротких кадров.
pub(crate) const OVERLAP: usize = 120;

/// Число коротких блоков в транзиентном кадре.
pub(crate) const SHORT_BLOCKS: usize = 8;

const SHORT_N: usize = FRAME_N / SHORT_BLOCKS;
const SUPPORT_START: usize = (FRAME_N - OVERLAP) / 2;

pub(crate) struct FrameTransform {
    long: Mdct,
    short: Mdct,
}

impl FrameTransform {
    pub fn new() -> Self {
        Self {
            long: Mdct::new(FRAME_N, OVERLAP),
            short: Mdct::new(SHORT_N, OVERLAP),
        }
    }

    /// `buf` — 2N сэмплов `[prev | cur]`, `coeffs` — N коэффициентов
    /// (в транзиентном режиме — интерливинг коротких спектров).
    pub fn forward(&self, transient: bool, buf: &[f32], coeffs: &mut [f32]) {
        debug_assert_eq!(buf.len(), 2 * FRAME_N);
        debug_assert_eq!(coeffs.len(), FRAME_N);
        if !transient {
            self.long.forward(buf, coeffs);
            return;
        }
        let mut block = [0f32; SHORT_N];
        for j in 0..SHORT_BLOCKS {
            let start = SUPPORT_START + j * SHORT_N;
            self.short
                .forward(&buf[start..start + 2 * SHORT_N], &mut block);
            for (f, &c) in block.iter().enumerate() {
                coeffs[f * SHORT_BLOCKS + j] = c;
            }
        }
    }

    /// `coeffs` — N коэффициентов, `out` — 2N windowed-сэмплов для overlap-add.
    pub fn inverse(&self, transient: bool, coeffs: &[f32], out: &mut [f32]) {
        debug_assert_eq!(coeffs.len(), FRAME_N);
        debug_assert_eq!(out.len(), 2 * FRAME_N);
        if !transient {
            self.long.inverse(coeffs, out);
            return;
        }
        out.fill(0.0);
        let mut block = [0f32; SHORT_N];
        let mut synth = [0f32; 2 * SHORT_N];
        for j in 0..SHORT_BLOCKS {
            for (f, c) in block.iter_mut().enumerate() {
                *c = coeffs[f * SHORT_BLOCKS + j];
            }
            self.short.inverse(&block, &mut synth);
            let start = SUPPORT_START + j * SHORT_N;
            for (o, &v) in out[start..start + 2 * SHORT_N].iter_mut().zip(&synth) {
                *o += v;
            }
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

    /// Ключевой тест склейки: последовательность кадров с произвольным
    /// чередованием длинного и транзиентного режимов реконструируется точно.
    #[test]
    fn perfect_reconstruction_across_mode_switches() {
        let tf = FrameTransform::new();
        let n = FRAME_N;
        // Все переходы режимов: long→long, long→short, short→short, short→long.
        let modes = [
            false, false, true, false, true, true, true, false, false, true,
        ];
        let hops = modes.len();
        let mut state = 0x5EED_0001u32;
        let x: Vec<f32> = (0..hops * n).map(|_| xorshift(&mut state)).collect();

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
            let transient = if h < hops { modes[h] } else { false };
            let mut buf = prev.clone();
            buf.extend_from_slice(&cur);
            tf.forward(transient, &buf, &mut coeffs);
            prev = cur;

            tf.inverse(transient, &coeffs, &mut synth);
            for j in 0..n {
                recon.push(ola[j] + synth[j]);
            }
            ola.copy_from_slice(&synth[n..]);
        }

        for (i, &orig) in x.iter().enumerate() {
            let got = recon[n + i];
            assert!(
                (got - orig).abs() < 1e-4,
                "sample {i} (hop {}): {got} vs {orig}",
                i / n
            );
        }
    }

    #[test]
    fn short_blocks_tile_the_window_support() {
        assert_eq!(
            SUPPORT_START + (SHORT_BLOCKS - 1) * SHORT_N + 2 * SHORT_N,
            2 * FRAME_N - SUPPORT_START
        );
        assert_eq!(SHORT_N, OVERLAP); // короткие блоки полноперекрывающиеся
    }
}
