//! Компенсация движения (нормативная).
//!
//! - Векторы движения — в ¼-пикселях люмы (в хроме 4:2:0 это ⅛ пикселя).
//! - Люма: раздельная 6-tap интерполяция (фильтры VP8/RFC 6386, фазы 0/¼/½/¾),
//!   промежуточная стадия без округления, единственный `round_shift(·, 14)` в конце.
//! - Хрома: билинейная интерполяция с 8 фазами.
//! - Выход за границы кадра нормативно определён клампом позиции блока
//!   (эквивалентно репликационной рамке); реализация — `PadPlane`.

use crate::Blk;
use crate::frame::{Frame, Plane};

/// Вектор движения в ¼-пикселях люмы.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Mv {
    pub x: i32,
    pub y: i32,
}

/// Кламп компоненты MV после сложения предиктора с разностью (анти-переполнение).
pub const MV_CLAMP: i32 = 1 << 20;
/// Максимум |mvd| на компоненту (ограничение синтаксиса).
pub const MVD_MAX: i32 = 2047;

/// Рамка опорной плоскости: люма 32, хрома 16 (покрывает 6-tap и максимум клампа).
pub const LUMA_BORDER: usize = 32;
pub const CHROMA_BORDER: usize = 16;

/// 6-tap фильтры суб-пиксельной интерполяции (RFC 6386), фазы ⅛; сумма 128.
const SUBPEL_6TAP: [[i32; 6]; 8] = [
    [0, 0, 128, 0, 0, 0],
    [0, -6, 123, 12, -1, 0],
    [2, -11, 108, 36, -8, 1],
    [0, -9, 93, 50, -6, 0],
    [3, -16, 77, 77, -16, 3],
    [0, -6, 50, 93, -9, 0],
    [1, -8, 36, 108, -11, 2],
    [0, -1, 12, 123, -6, 0],
];

/// Плоскость с репликационной рамкой шириной `border`.
pub struct PadPlane {
    data: Vec<u8>,
    stride: usize,
    w: usize,
    h: usize,
    border: usize,
}

impl PadPlane {
    pub fn from_plane(p: &Plane, border: usize) -> PadPlane {
        let (w, h) = (p.width(), p.height());
        let stride = w + 2 * border;
        let mut data = vec![0u8; stride * (h + 2 * border)];
        for y in 0..h {
            let dst = (y + border) * stride + border;
            data[dst..dst + w].copy_from_slice(p.row(y));
            // Горизонтальная репликация краёв строки.
            let first = p.row(y)[0];
            let last = p.row(y)[w - 1];
            let row = (y + border) * stride;
            data[row..row + border].fill(first);
            data[row + border + w..row + stride].fill(last);
        }
        // Вертикальная репликация (вместе с углами).
        let top_src = border * stride;
        let top_row = data[top_src..top_src + stride].to_vec();
        let bot_src = (border + h - 1) * stride;
        let bot_row = data[bot_src..bot_src + stride].to_vec();
        for y in 0..border {
            data[y * stride..(y + 1) * stride].copy_from_slice(&top_row);
            let dst = (border + h + y) * stride;
            data[dst..dst + stride].copy_from_slice(&bot_row);
        }
        PadPlane { data, stride, w, h, border }
    }

    #[inline]
    pub fn width(&self) -> usize {
        self.w
    }

    #[inline]
    pub fn height(&self) -> usize {
        self.h
    }

    /// Отсчёт в координатах кадра; допускается |x|,|y| ≤ border за границами.
    #[inline]
    pub fn at(&self, x: isize, y: isize) -> u8 {
        debug_assert!(x >= -(self.border as isize) && x < (self.w + self.border) as isize);
        debug_assert!(y >= -(self.border as isize) && y < (self.h + self.border) as isize);
        let xi = (x + self.border as isize) as usize;
        let yi = (y + self.border as isize) as usize;
        self.data[yi * self.stride + xi]
    }
}

/// Опорный кадр: финальное изображение + плоскости с рамкой для MC.
pub struct RefFrame {
    pub frame: Frame,
    pub y: PadPlane,
    pub cb: PadPlane,
    pub cr: PadPlane,
}

impl RefFrame {
    pub fn new(frame: Frame) -> RefFrame {
        let y = PadPlane::from_plane(&frame.y, LUMA_BORDER);
        let cb = PadPlane::from_plane(&frame.cb, CHROMA_BORDER);
        let cr = PadPlane::from_plane(&frame.cr, CHROMA_BORDER);
        RefFrame { frame, y, cb, cr }
    }
}

/// Кламп позиции блока люмы в ¼-пикселях (нормативный): фильтру нужны
/// 2 отсчёта слева/сверху и 3 справа/снизу внутри рамки 32.
#[inline]
fn clamp_luma_pos(p: i32, dim: usize, n: usize) -> i32 {
    let lo = -4 * (LUMA_BORDER as i32 - 3);
    let hi = 4 * (dim as i32 - n as i32 + LUMA_BORDER as i32 - 3);
    p.clamp(lo, hi)
}

/// Кламп позиции блока хромы в ⅛-пикселях (нормативный): билинейной
/// интерполяции нужен 1 отсчёт справа/снизу внутри рамки 16.
#[inline]
fn clamp_chroma_pos(p: i32, dim: usize, n: usize) -> i32 {
    let lo = -8 * (CHROMA_BORDER as i32 - 2);
    let hi = 8 * (dim as i32 - n as i32 + CHROMA_BORDER as i32 - 2);
    p.clamp(lo, hi)
}

/// MC-предсказание блока люмы `b` (люма-координаты) вектором `mv` в `pred`
/// (raster, длина n²).
pub fn mc_luma(rp: &PadPlane, b: Blk, mv: Mv, pred: &mut [i32]) {
    let n = b.n;
    let px = clamp_luma_pos(4 * b.x as i32 + mv.x, rp.w, n);
    let py = clamp_luma_pos(4 * b.y as i32 + mv.y, rp.h, n);
    let (x0, fx) = (px >> 2, (px & 3) as usize);
    let (y0, fy) = (py >> 2, (py & 3) as usize);
    let hf = &SUBPEL_6TAP[fx * 2];
    let vf = &SUBPEL_6TAP[fy * 2];

    // Горизонтальная стадия: (n+5) строк × n столбцов, без округления.
    let mut tmp = [0i32; 69 * 64];
    for r in 0..n + 5 {
        let sy = y0 as isize + r as isize - 2;
        for c in 0..n {
            let sx = x0 as isize + c as isize - 2;
            let mut acc = 0i32;
            for (j, &t) in hf.iter().enumerate() {
                acc += t * i32::from(rp.at(sx + j as isize, sy));
            }
            tmp[r * n + c] = acc;
        }
    }
    // Вертикальная стадия + нормализация 128·128 = 2¹⁴.
    for r in 0..n {
        for c in 0..n {
            let mut acc = 0i64;
            for (j, &t) in vf.iter().enumerate() {
                acc += i64::from(t) * i64::from(tmp[(r + j) * n + c]);
            }
            pred[r * n + c] = (((acc + (1 << 13)) >> 14) as i32).clamp(0, 255);
        }
    }
}

/// MC-предсказание блока хромы `bc` (хрома-координаты) вектором `mv`
/// (в ¼-пикселях люмы = ⅛ пикселя хромы) в `pred` (raster, длина n²).
pub fn mc_chroma(rp: &PadPlane, bc: Blk, mv: Mv, pred: &mut [i32]) {
    let n = bc.n;
    let px = clamp_chroma_pos(8 * bc.x as i32 + mv.x, rp.w, n);
    let py = clamp_chroma_pos(8 * bc.y as i32 + mv.y, rp.h, n);
    let (x0, fx) = ((px >> 3) as isize, px & 7);
    let (y0, fy) = ((py >> 3) as isize, py & 7);
    for r in 0..n {
        for c in 0..n {
            let a = i32::from(rp.at(x0 + c as isize, y0 + r as isize));
            let b_ = i32::from(rp.at(x0 + c as isize + 1, y0 + r as isize));
            let cc = i32::from(rp.at(x0 + c as isize, y0 + r as isize + 1));
            let d = i32::from(rp.at(x0 + c as isize + 1, y0 + r as isize + 1));
            let top = (8 - fx) * a + fx * b_;
            let bot = (8 - fx) * cc + fx * d;
            pred[r * n + c] = ((8 - fy) * top + fy * bot + 32) >> 6;
        }
    }
}

/// Медиана трёх (покомпонентно для MV-предиктора).
#[inline]
pub fn med3(a: i32, b: i32, c: i32) -> i32 {
    a.max(b.min(c)).min(a.min(b).max(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp_plane(w: usize, h: usize) -> Plane {
        let mut p = Plane::new(w, h);
        for y in 0..h {
            for x in 0..w {
                p.set(x, y, ((x * 3 + y * 7) % 251) as u8);
            }
        }
        p
    }

    /// Фаза 0 (целочисленный MV) — точная копия источника.
    #[test]
    fn full_pel_is_copy() {
        let p = ramp_plane(64, 48);
        let rp = PadPlane::from_plane(&p, LUMA_BORDER);
        let b = Blk { x: 16, y: 8, n: 16 };
        let mut pred = [0i32; 64 * 64];
        for &(dx, dy) in &[(0i32, 0i32), (4, 0), (-8, 4), (16, -12)] {
            mc_luma(&rp, b, Mv { x: dx * 4, y: dy * 4 }, &mut pred);
            for r in 0..16 {
                for c in 0..16 {
                    let sx = (b.x as i32 + c as i32 + dx).clamp(0, 63) as usize;
                    let sy = (b.y as i32 + r as i32 + dy).clamp(0, 47) as usize;
                    assert_eq!(pred[r * 16 + c], i32::from(p.get(sx, sy)), "d=({dx},{dy}) r={r} c={c}");
                }
            }
        }
    }

    /// Полупиксель на линейном градиенте — среднее соседей.
    #[test]
    fn half_pel_on_gradient() {
        let mut p = Plane::new(64, 64);
        for y in 0..64 {
            for x in 0..64 {
                p.set(x, y, (x * 4) as u8);
            }
        }
        let rp = PadPlane::from_plane(&p, LUMA_BORDER);
        let b = Blk { x: 24, y: 24, n: 8 };
        let mut pred = [0i32; 64 * 64];
        mc_luma(&rp, b, Mv { x: 2, y: 0 }, &mut pred); // +½ пикселя по x
        for r in 0..8 {
            for c in 0..8 {
                let expect = (24 + c) * 4 + 2; // между x·4 и (x+1)·4
                assert!(
                    (pred[r * 8 + c] - expect as i32).abs() <= 1,
                    "r={r} c={c}: {} vs {expect}",
                    pred[r * 8 + c]
                );
            }
        }
    }

    /// MV далеко за границей кадра — кламп, без паники, детерминированная репликация.
    #[test]
    fn out_of_bounds_clamps() {
        let p = ramp_plane(32, 32);
        let rp = PadPlane::from_plane(&p, LUMA_BORDER);
        let b = Blk { x: 0, y: 0, n: 16 };
        let mut pred = [0i32; 64 * 64];
        for &mv in &[
            Mv { x: -100_000, y: -100_000 },
            Mv { x: 100_000, y: 100_000 },
            Mv { x: -100_000, y: 100_000 },
        ] {
            mc_luma(&rp, b, mv, &mut pred);
            for v in &pred[..256] {
                assert!((0..=255).contains(v));
            }
        }
        let rpc = PadPlane::from_plane(&p, CHROMA_BORDER);
        mc_chroma(&rpc, Blk { x: 0, y: 0, n: 8 }, Mv { x: 99_999, y: -99_999 }, &mut pred);
        for v in &pred[..64] {
            assert!((0..=255).contains(v));
        }
    }

    /// Хрома: фаза 0 — копия; фаза ½ на градиенте — среднее.
    #[test]
    fn chroma_bilinear() {
        let p = ramp_plane(32, 32);
        let rp = PadPlane::from_plane(&p, CHROMA_BORDER);
        let bc = Blk { x: 8, y: 8, n: 8 };
        let mut pred = [0i32; 64 * 64];
        mc_chroma(&rp, bc, Mv { x: 0, y: 0 }, &mut pred);
        for r in 0..8 {
            for c in 0..8 {
                assert_eq!(pred[r * 8 + c], i32::from(p.get(8 + c, 8 + r)));
            }
        }
        let mut flat = Plane::new(16, 16);
        for y in 0..16 {
            for x in 0..16 {
                flat.set(x, y, (y * 10) as u8);
            }
        }
        let rp2 = PadPlane::from_plane(&flat, CHROMA_BORDER);
        mc_chroma(&rp2, Blk { x: 4, y: 4, n: 4 }, Mv { x: 0, y: 4 }, &mut pred); // +½ по y
        for r in 0..4 {
            for c in 0..4 {
                let expect = (4 + r) * 10 + 5;
                assert_eq!(pred[r * 4 + c], expect as i32, "r={r} c={c}");
            }
        }
    }

    #[test]
    fn med3_works() {
        assert_eq!(med3(1, 5, 3), 3);
        assert_eq!(med3(-4, -4, 7), -4);
        assert_eq!(med3(0, 0, 0), 0);
        assert_eq!(med3(9, 2, 5), 5);
    }
}
