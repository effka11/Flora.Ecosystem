//! Метрики качества (инструментальные, не нормативные — float допустим).

use crate::Blk;
use crate::frame::{Frame, Plane};

fn plane_sse(a: &Plane, b: &Plane) -> u64 {
    a.data()
        .iter()
        .zip(b.data())
        .map(|(&x, &y)| {
            let d = i64::from(x) - i64::from(y);
            (d * d) as u64
        })
        .sum()
}

fn mse_to_psnr(sse: u64, samples: u64) -> f64 {
    if sse == 0 {
        return f64::INFINITY;
    }
    let mse = sse as f64 / samples as f64;
    10.0 * (255.0 * 255.0 / mse).log10()
}

#[derive(Debug, Clone, Copy)]
pub struct Psnr {
    pub y: f64,
    pub cb: f64,
    pub cr: f64,
    /// Взвешенный итог (4·Y + Cb + Cr) / 6 по SSE.
    pub overall: f64,
}

/// PSNR между двумя кадрами одинакового размера.
pub fn psnr(a: &Frame, b: &Frame) -> Psnr {
    let sy = plane_sse(&a.y, &b.y);
    let scb = plane_sse(&a.cb, &b.cb);
    let scr = plane_sse(&a.cr, &b.cr);
    let ny = (a.y.width() * a.y.height()) as u64;
    let nc = (a.cb.width() * a.cb.height()) as u64;
    Psnr {
        y: mse_to_psnr(sy, ny),
        cb: mse_to_psnr(scb, nc),
        cr: mse_to_psnr(scr, nc),
        overall: mse_to_psnr(sy + scb + scr, ny + 2 * nc),
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Ssim {
    pub y: f64,
    pub cb: f64,
    pub cr: f64,
    /// Взвешенный итог (4·Y + Cb + Cr) / 6 — та же схема, что у PSNR.
    pub overall: f64,
}

/// SSIM одной плоскости: окна 8×8 с шагом 4 (схема tiny_ssim/x264), C1/C2 —
/// стандартные константы для 8-битного диапазона.
fn plane_ssim(a: &Plane, b: &Plane) -> f64 {
    const C1: f64 = 6.5025; // (0.01·255)²
    const C2: f64 = 58.5225; // (0.03·255)²
    let (w, h) = (a.width(), a.height());
    let win = 8.min(w).min(h);
    if win == 0 {
        return 1.0;
    }
    let n = (win * win) as f64;
    let mut sum = 0.0f64;
    let mut windows = 0u64;
    let mut y0 = 0;
    while y0 + win <= h {
        let mut x0 = 0;
        while x0 + win <= w {
            let (mut sx, mut sy, mut sxx, mut syy, mut sxy) = (0u32, 0u32, 0u32, 0u32, 0u32);
            for dy in 0..win {
                for dx in 0..win {
                    let px = u32::from(a.get(x0 + dx, y0 + dy));
                    let py = u32::from(b.get(x0 + dx, y0 + dy));
                    sx += px;
                    sy += py;
                    sxx += px * px;
                    syy += py * py;
                    sxy += px * py;
                }
            }
            let (sx, sy) = (f64::from(sx), f64::from(sy));
            let (sxx, syy, sxy) = (f64::from(sxx), f64::from(syy), f64::from(sxy));
            let mx = sx / n;
            let my = sy / n;
            let var_x = (sxx - sx * mx).max(0.0) / n;
            let var_y = (syy - sy * my).max(0.0) / n;
            let cov = (sxy - sx * my) / n;
            sum += ((2.0 * mx * my + C1) * (2.0 * cov + C2))
                / ((mx * mx + my * my + C1) * (var_x + var_y + C2));
            windows += 1;
            x0 += 4;
        }
        y0 += 4;
    }
    if windows == 0 {
        1.0
    } else {
        sum / windows as f64
    }
}

/// SSIM между двумя кадрами одинакового размера (инструментальный, не нормативный).
pub fn ssim(a: &Frame, b: &Frame) -> Ssim {
    let y = plane_ssim(&a.y, &b.y);
    let cb = plane_ssim(&a.cb, &b.cb);
    let cr = plane_ssim(&a.cr, &b.cr);
    Ssim {
        y,
        cb,
        cr,
        overall: (4.0 * y + cb + cr) / 6.0,
    }
}

/// Аккумулятор SSIM по последовательности (среднее по кадрам).
#[derive(Debug, Default, Clone, Copy)]
pub struct SsimAccum {
    sum_y: f64,
    sum_cb: f64,
    sum_cr: f64,
    n: u64,
}

impl SsimAccum {
    pub fn add(&mut self, a: &Frame, b: &Frame) {
        let s = ssim(a, b);
        self.sum_y += s.y;
        self.sum_cb += s.cb;
        self.sum_cr += s.cr;
        self.n += 1;
    }

    pub fn result(&self) -> Ssim {
        let n = self.n.max(1) as f64;
        let (y, cb, cr) = (self.sum_y / n, self.sum_cb / n, self.sum_cr / n);
        Ssim {
            y,
            cb,
            cr,
            overall: (4.0 * y + cb + cr) / 6.0,
        }
    }
}

/// Аккумулятор PSNR по последовательности (среднее по SSE, не по dB).
#[derive(Debug, Default, Clone, Copy)]
pub struct PsnrAccum {
    sse_y: u64,
    sse_cb: u64,
    sse_cr: u64,
    n_y: u64,
    n_c: u64,
}

impl PsnrAccum {
    pub fn add(&mut self, a: &Frame, b: &Frame) {
        self.sse_y += plane_sse(&a.y, &b.y);
        self.sse_cb += plane_sse(&a.cb, &b.cb);
        self.sse_cr += plane_sse(&a.cr, &b.cr);
        self.n_y += (a.y.width() * a.y.height()) as u64;
        self.n_c += (a.cb.width() * a.cb.height()) as u64;
    }

    pub fn result(&self) -> Psnr {
        Psnr {
            y: mse_to_psnr(self.sse_y, self.n_y),
            cb: mse_to_psnr(self.sse_cb, self.n_c),
            cr: mse_to_psnr(self.sse_cr, self.n_c),
            overall: mse_to_psnr(
                self.sse_y + self.sse_cb + self.sse_cr,
                self.n_y + 2 * self.n_c,
            ),
        }
    }
}

/// Целочисленный SSIM-прокси для RDO (не нормативен): 0 = идеально, порядок величины как у SSE.
pub(crate) fn block_ssim_dist(src: &Plane, b: Blk, pred: &[i32]) -> u64 {
    let n = b.n;
    let n2 = (n * n) as i64;
    let mut sum_x = 0i64;
    let mut sum_y = 0i64;
    let mut sum_xx = 0i64;
    let mut sum_yy = 0i64;
    let mut sum_xy = 0i64;
    for i in 0..n {
        for j in 0..n {
            let x = i64::from(src.get(b.x + j, b.y + i));
            let y = i64::from(pred[i * n + j].clamp(0, 255));
            sum_x += x;
            sum_y += y;
            sum_xx += x * x;
            sum_yy += y * y;
            sum_xy += x * y;
        }
    }
    let var_x = sum_xx * n2 - sum_x * sum_x;
    let var_y = sum_yy * n2 - sum_y * sum_y;
    let cov = sum_xy * n2 - sum_x * sum_y;
    let struct_d = (var_x + var_y - 2 * cov).max(0) as u64;
    let mean_d = (sum_x - sum_y).unsigned_abs();
    let log_n = n.trailing_zeros();
    (struct_d >> (log_n + 6)) + (mean_d.saturating_mul(4) >> u64::from(log_n))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pattern_frame(w: usize, h: usize) -> Frame {
        let mut f = Frame::new(w, h);
        for y in 0..h {
            for x in 0..w {
                f.y.set(x, y, ((x * 5 + y * 3) % 256) as u8);
            }
        }
        for y in 0..h / 2 {
            for x in 0..w / 2 {
                f.cb.set(x, y, (100 + x) as u8);
                f.cr.set(x, y, (150 + y) as u8);
            }
        }
        f
    }

    #[test]
    fn ssim_identity_is_one() {
        let f = pattern_frame(64, 48);
        let s = ssim(&f, &f);
        assert!((s.y - 1.0).abs() < 1e-9);
        assert!((s.overall - 1.0).abs() < 1e-9);
    }

    #[test]
    fn ssim_decreases_with_degradation() {
        let f = pattern_frame(64, 48);
        let mut light = f.clone();
        let mut heavy = f.clone();
        for (i, v) in light.y.data_mut().iter_mut().enumerate() {
            *v = v.wrapping_add(((i * 7) % 5) as u8);
        }
        for (i, v) in heavy.y.data_mut().iter_mut().enumerate() {
            *v = v.wrapping_add(((i * 31) % 61) as u8);
        }
        let s_light = ssim(&f, &light);
        let s_heavy = ssim(&f, &heavy);
        assert!(s_light.y < 1.0);
        assert!(s_heavy.y < s_light.y, "{} vs {}", s_heavy.y, s_light.y);
        assert!(s_heavy.y > 0.0);
    }

    #[test]
    fn ssim_accum_averages() {
        let f = pattern_frame(32, 32);
        let mut acc = SsimAccum::default();
        acc.add(&f, &f);
        acc.add(&f, &f);
        assert!((acc.result().overall - 1.0).abs() < 1e-9);
    }
}
