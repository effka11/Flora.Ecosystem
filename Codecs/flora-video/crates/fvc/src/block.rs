//! Общие для энкодера и декодера операции листа разбиения (нормативные).
//!
//! Один и тот же код реконструкции используется обеими сторонами — паритет
//! «реконструкция энкодера == выход декодера» обеспечивается конструктивно.

use crate::Blk;
use crate::frame::Plane;
use crate::predict::{RefGrid, Refs, is_directional, predict};
use crate::quant::dequantize_block;
use crate::transform::inverse;

/// Размер transform-тайла люмы для листа n: базовый `min(n,32)`,
/// с `tx_split` — вдвое мельче (нормативно).
#[inline]
pub fn luma_tile_size(n: usize, tx_split: bool) -> usize {
    let base = n.min(32);
    if tx_split { base / 2 } else { base }
}

/// Данные листа: режим и квантованные уровни (решения энкодера / разбор декодера).
#[derive(Debug, Clone)]
pub struct LeafData {
    pub mode: u8,
    /// Трансформ люмы вдвое мельче базового.
    pub tx_split: bool,
    /// Тайлы люмы в raster-порядке; уровни — в raster-порядке внутри тайла.
    pub luma: Vec<Vec<i32>>,
    pub cb: Vec<i32>,
    pub cr: Vec<i32>,
}

/// Реконструкция блока одной плоскости: предсказание всего блока по опорам
/// из реконструированных соседей + потайловые остатки (dequant → inverse → add).
pub fn reconstruct_plane_block(
    plane: &mut Plane,
    b: Blk,
    g: RefGrid,
    tsize: usize,
    mode: u8,
    tiles: &[Vec<i32>],
    qp: u8,
) {
    let refs = Refs::gather(plane, b.x, b.y, b.n, g);
    let mut pred = [0i32; 64 * 64];
    predict(mode, &refs, b.n, &mut pred);
    let per_row = b.n / tsize;
    let t2 = tsize * tsize;
    let mut deq = [0i32; 32 * 32];
    let mut res = [0i32; 32 * 32];
    for (ti, tile) in tiles.iter().enumerate().take(per_row * per_row) {
        let (ty, tx) = (ti / per_row, ti % per_row);
        dequantize_block(&tile[..t2], &mut deq[..t2], qp);
        inverse(&deq[..t2], tsize, &mut res[..t2]);
        for i in 0..tsize {
            for j in 0..tsize {
                let p = pred[(ty * tsize + i) * b.n + tx * tsize + j];
                let v = (p + res[i * tsize + j]).clamp(0, 255) as u8;
                plane.set(b.x + tx * tsize + j, b.y + ty * tsize + i, v);
            }
        }
    }
}

/// Контекстная сетка режимов 8×8 (для кодирования режима листа).
pub struct ModeGrid {
    w8: usize,
    cells: Vec<u8>,
}

pub const MODE_UNAVAILABLE: u8 = 255;

impl ModeGrid {
    pub fn new(width: usize, height: usize) -> Self {
        let w8 = width / 8;
        ModeGrid {
            w8,
            cells: vec![MODE_UNAVAILABLE; w8 * (height / 8)],
        }
    }

    /// Контекст «сколько соседей (сверху/слева) направленные»: 0..=2.
    pub fn dir_ctx(&self, x: usize, y: usize) -> usize {
        let (cx, cy) = (x / 8, y / 8);
        let mut ctx = 0;
        let above = if cy > 0 {
            self.cells[(cy - 1) * self.w8 + cx]
        } else {
            MODE_UNAVAILABLE
        };
        let left = if cx > 0 {
            self.cells[cy * self.w8 + cx - 1]
        } else {
            MODE_UNAVAILABLE
        };
        if above != MODE_UNAVAILABLE && is_directional(above) {
            ctx += 1;
        }
        if left != MODE_UNAVAILABLE && is_directional(left) {
            ctx += 1;
        }
        ctx
    }

    pub fn fill(&mut self, x: usize, y: usize, n: usize, mode: u8) {
        for cy in y / 8..(y + n) / 8 {
            for cx in x / 8..(x + n) / 8 {
                self.cells[cy * self.w8 + cx] = mode;
            }
        }
    }
}
