//! Метрики качества (инструментальные, не нормативные — float допустим).

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
            overall: mse_to_psnr(self.sse_y + self.sse_cb + self.sse_cr, self.n_y + 2 * self.n_c),
        }
    }
}
