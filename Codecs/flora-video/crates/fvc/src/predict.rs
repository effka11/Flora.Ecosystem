//! Интра-предикторы (нормативные): DC, V, H, TM (TrueMotion).
//!
//! Опорные отсчёты берутся из уже реконструированных пикселей плоскости.
//! Недоступные опоры (граница кадра) заменяются константой 128.

use crate::frame::Plane;

pub const MODE_DC: u8 = 0;
pub const MODE_TM: u8 = 1;
pub const MODE_V: u8 = 2;
pub const MODE_H: u8 = 3;
pub const NUM_MODES: usize = 4;

/// Опоры блока n×n в позиции (x, y): above[n], left[n], above_left.
pub struct Refs {
    pub above: [u8; 64],
    pub left: [u8; 64],
    pub above_left: u8,
    pub has_above: bool,
    pub has_left: bool,
}

impl Refs {
    pub fn gather(plane: &Plane, x: usize, y: usize, n: usize) -> Refs {
        let mut r = Refs {
            above: [128; 64],
            left: [128; 64],
            above_left: 128,
            has_above: y > 0,
            has_left: x > 0,
        };
        if r.has_above {
            let row = plane.row(y - 1);
            r.above[..n].copy_from_slice(&row[x..x + n]);
        }
        if r.has_left {
            for i in 0..n {
                r.left[i] = plane.get(x - 1, y + i);
            }
        }
        if r.has_above && r.has_left {
            r.above_left = plane.get(x - 1, y - 1);
        }
        r
    }
}

/// Предсказание блока n×n в `pred` (raster, длина n²).
pub fn predict(mode: u8, refs: &Refs, n: usize, pred: &mut [i32]) {
    match mode {
        MODE_DC => {
            let sum_above: u32 = refs.above[..n].iter().map(|&v| u32::from(v)).sum();
            let sum_left: u32 = refs.left[..n].iter().map(|&v| u32::from(v)).sum();
            let dc = match (refs.has_above, refs.has_left) {
                (true, true) => (sum_above + sum_left + n as u32) / (2 * n as u32),
                (true, false) => (sum_above + n as u32 / 2) / n as u32,
                (false, true) => (sum_left + n as u32 / 2) / n as u32,
                (false, false) => 128,
            } as i32;
            pred[..n * n].fill(dc);
        }
        MODE_V => {
            for i in 0..n {
                for j in 0..n {
                    pred[i * n + j] = i32::from(refs.above[j]);
                }
            }
        }
        MODE_H => {
            for i in 0..n {
                let l = i32::from(refs.left[i]);
                pred[i * n..(i + 1) * n].fill(l);
            }
        }
        _ => {
            // TM: p[i][j] = clamp(left[i] + above[j] - above_left)
            let al = i32::from(refs.above_left);
            for i in 0..n {
                let l = i32::from(refs.left[i]);
                for j in 0..n {
                    pred[i * n + j] = (l + i32::from(refs.above[j]) - al).clamp(0, 255);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dc_without_refs_is_128() {
        let plane = Plane::new(16, 16);
        let refs = Refs::gather(&plane, 0, 0, 8);
        let mut pred = [0i32; 64];
        predict(MODE_DC, &refs, 8, &mut pred);
        assert!(pred.iter().all(|&p| p == 128));
    }

    #[test]
    fn v_copies_above_row() {
        let mut plane = Plane::new(16, 16);
        for j in 0..16 {
            plane.set(j, 3, (j * 10) as u8);
        }
        let refs = Refs::gather(&plane, 8, 4, 8);
        let mut pred = [0i32; 64];
        predict(MODE_V, &refs, 8, &mut pred);
        for i in 0..8 {
            for j in 0..8 {
                assert_eq!(pred[i * 8 + j], ((8 + j) * 10) as i32);
            }
        }
    }

    #[test]
    fn tm_degrades_to_h_without_above() {
        let mut plane = Plane::new(16, 16);
        for i in 0..16 {
            plane.set(7, i, (40 + i) as u8);
        }
        let refs = Refs::gather(&plane, 8, 0, 8);
        let mut pred = [0i32; 64];
        predict(MODE_TM, &refs, 8, &mut pred);
        // above=128, al=128 → pred = left[i]
        for i in 0..8 {
            for j in 0..8 {
                assert_eq!(pred[i * 8 + j], 40 + i as i32);
            }
        }
    }
}
