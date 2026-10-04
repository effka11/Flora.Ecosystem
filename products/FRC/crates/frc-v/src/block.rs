//! Общие для энкодера и декодера операции листа разбиения (нормативные).
//!
//! Один и тот же код реконструкции используется обеими сторонами — паритет
//! «реконструкция энкодера == выход декодера» обеспечивается конструктивно.

use crate::frame::{Frame, Plane};
use crate::mc::{MV_CLAMP, Mv, RefFrame, mc_chroma, mc_luma, med3};
use crate::predict::{CHROMA_GRID, LUMA_GRID, Refs, is_directional, predict};
use crate::quant::dequantize_block;
use crate::transform::inverse;
use crate::{Blk, MIN_BLOCK};

/// Размер transform-тайла люмы для листа n: базовый `min(n,32)`,
/// с `tx_split` — вдвое мельче (нормативно).
#[inline]
pub fn luma_tile_size(n: usize, tx_split: bool) -> usize {
    let base = n.min(32);
    if tx_split { base / 2 } else { base }
}

/// Способ предсказания листа.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeafKind {
    /// Интра: люма-режим + хрома-режим (`None` — совпадает с люмой).
    Intra { mode: u8, chroma_mode: Option<u8> },
    /// Интер: вектор движения (¼ пикселя люмы) и флаг «без остатка».
    Inter { mv: Mv, skip: bool },
}

/// Данные листа: решения энкодера / разбор декодера.
#[derive(Debug, Clone)]
pub struct LeafData {
    pub kind: LeafKind,
    /// Трансформ люмы вдвое мельче базового (для skip всегда false).
    pub tx_split: bool,
    /// Тайлы люмы в raster-порядке; уровни — в raster-порядке внутри тайла.
    pub luma: Vec<Vec<i32>>,
    pub cb: Vec<i32>,
    pub cr: Vec<i32>,
}

/// Интра-предсказание блока одной плоскости в `pred` (raster n²).
pub fn intra_pred_plane(plane: &Plane, b: Blk, luma: bool, mode: u8, pred: &mut [i32]) {
    let g = if luma { LUMA_GRID } else { CHROMA_GRID };
    let refs = Refs::gather(plane, b.x, b.y, b.n, g);
    predict(mode, &refs, b.n, pred);
}

/// Добавление остатков к предсказанию: тайлы в raster-порядке,
/// dequant → inverse → clamp(pred + res).
pub fn add_residual_tiles(
    plane: &mut Plane,
    b: Blk,
    tsize: usize,
    pred: &[i32],
    tiles: &[Vec<i32>],
    qp: u8,
) {
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

/// Запись предсказания без остатка (skip).
pub fn write_pred(plane: &mut Plane, b: Blk, pred: &[i32]) {
    for i in 0..b.n {
        for j in 0..b.n {
            plane.set(b.x + j, b.y + i, pred[i * b.n + j].clamp(0, 255) as u8);
        }
    }
}

/// Полная реконструкция листа (нормативная, общая для энкодера и декодера).
/// Для inter-листьев `reference` обязан существовать.
pub fn reconstruct_leaf(
    frame: &mut Frame,
    reference: Option<&RefFrame>,
    b: Blk,
    leaf: &LeafData,
    qp: u8,
) {
    let bc = b.chroma();
    let mut pred = [0i32; 64 * 64];
    match leaf.kind {
        LeafKind::Intra { mode, chroma_mode } => {
            let tsize = luma_tile_size(b.n, leaf.tx_split);
            intra_pred_plane(&frame.y, b, true, mode, &mut pred);
            add_residual_tiles(&mut frame.y, b, tsize, &pred, &leaf.luma, qp);
            let cmode = chroma_mode.unwrap_or(mode);
            intra_pred_plane(&frame.cb, bc, false, cmode, &mut pred);
            add_residual_tiles(
                &mut frame.cb,
                bc,
                bc.n,
                &pred,
                std::slice::from_ref(&leaf.cb),
                qp,
            );
            intra_pred_plane(&frame.cr, bc, false, cmode, &mut pred);
            add_residual_tiles(
                &mut frame.cr,
                bc,
                bc.n,
                &pred,
                std::slice::from_ref(&leaf.cr),
                qp,
            );
        }
        LeafKind::Inter { mv, skip } => {
            let r = reference.expect("inter leaf requires a reference frame");
            mc_luma(&r.y, b, mv, &mut pred);
            if skip {
                write_pred(&mut frame.y, b, &pred);
            } else {
                let tsize = luma_tile_size(b.n, leaf.tx_split);
                add_residual_tiles(&mut frame.y, b, tsize, &pred, &leaf.luma, qp);
            }
            mc_chroma(&r.cb, bc, mv, &mut pred);
            if skip {
                write_pred(&mut frame.cb, bc, &pred);
            } else {
                add_residual_tiles(
                    &mut frame.cb,
                    bc,
                    bc.n,
                    &pred,
                    std::slice::from_ref(&leaf.cb),
                    qp,
                );
            }
            mc_chroma(&r.cr, bc, mv, &mut pred);
            if skip {
                write_pred(&mut frame.cr, bc, &pred);
            } else {
                add_residual_tiles(
                    &mut frame.cr,
                    bc,
                    bc.n,
                    &pred,
                    std::slice::from_ref(&leaf.cr),
                    qp,
                );
            }
        }
    }
}

pub const MODE_INTER: u8 = 254;
pub const MODE_UNAVAILABLE: u8 = 255;

/// Контекстная сетка листьев по ячейкам 8×8: режим (или INTER) и MV.
/// Заполняется в порядке кодирования — состояние в любой точке потока
/// одинаково у энкодера и декодера.
#[derive(Clone)]
pub struct LeafGrid {
    w8: usize,
    modes: Vec<u8>,
    mvs: Vec<Mv>,
}

impl LeafGrid {
    pub fn new(width: usize, height: usize) -> Self {
        let w8 = width / MIN_BLOCK;
        let cells = w8 * (height / MIN_BLOCK);
        LeafGrid {
            w8,
            modes: vec![MODE_UNAVAILABLE; cells],
            mvs: vec![Mv::default(); cells],
        }
    }

    #[inline]
    fn mode_at(&self, cx: usize, cy: usize) -> u8 {
        self.modes[cy * self.w8 + cx]
    }

    /// Контекст «сколько соседей (сверху/слева) направленные»: 0..=2.
    pub fn dir_ctx(&self, x: usize, y: usize) -> usize {
        let (cx, cy) = (x / 8, y / 8);
        let mut ctx = 0;
        if cy > 0 {
            let m = self.mode_at(cx, cy - 1);
            if m != MODE_UNAVAILABLE && m != MODE_INTER && is_directional(m) {
                ctx += 1;
            }
        }
        if cx > 0 {
            let m = self.mode_at(cx - 1, cy);
            if m != MODE_UNAVAILABLE && m != MODE_INTER && is_directional(m) {
                ctx += 1;
            }
        }
        ctx
    }

    /// Контекст «сколько соседей (сверху/слева) inter»: 0..=2.
    pub fn inter_ctx(&self, x: usize, y: usize) -> usize {
        let (cx, cy) = (x / 8, y / 8);
        let mut ctx = 0;
        if cy > 0 && self.mode_at(cx, cy - 1) == MODE_INTER {
            ctx += 1;
        }
        if cx > 0 && self.mode_at(cx - 1, cy) == MODE_INTER {
            ctx += 1;
        }
        ctx
    }

    /// Предиктор MV листа (нормативный): кандидаты — inter-соседи
    /// слева, сверху, сверху-справа (при недоступности — сверху-слева).
    /// 0 кандидатов → (0,0); 1 → он сам; ≥2 → покомпонентная медиана
    /// (список дополняется (0,0) до трёх).
    pub fn mv_predictor(&self, x: usize, y: usize, n: usize) -> Mv {
        let (cx, cy) = (x / 8, y / 8);
        let mut cands: Vec<Mv> = Vec::with_capacity(3);
        let mut push = |cx: usize, cy: usize, s: &Self| {
            if s.mode_at(cx, cy) == MODE_INTER {
                cands.push(s.mvs[cy * s.w8 + cx]);
            }
        };
        if cx > 0 {
            push(cx - 1, cy, self);
        }
        if cy > 0 {
            push(cx, cy - 1, self);
            let arx = (x + n) / 8;
            if arx < self.w8 {
                push(arx, cy - 1, self);
            } else if cx > 0 {
                push(cx - 1, cy - 1, self);
            }
        }
        match cands.len() {
            0 => Mv::default(),
            1 => cands[0],
            _ => {
                while cands.len() < 3 {
                    cands.push(Mv::default());
                }
                Mv {
                    x: med3(cands[0].x, cands[1].x, cands[2].x),
                    y: med3(cands[0].y, cands[1].y, cands[2].y),
                }
            }
        }
    }

    /// MV ячейки 8×8, если лист был inter (temporal-кандидат энкодера).
    #[inline]
    pub fn mv_at(&self, x: usize, y: usize) -> Option<Mv> {
        let (cx, cy) = (x / 8, y / 8);
        let idx = cy * self.w8 + cx;
        (self.modes.get(idx).copied() == Some(MODE_INTER)).then(|| self.mvs[idx])
    }

    /// Восстановление MV из предиктора и разности (нормативный кламп).
    pub fn resolve_mv(&self, x: usize, y: usize, n: usize, mvd: Mv) -> Mv {
        let p = self.mv_predictor(x, y, n);
        Mv {
            x: (p.x + mvd.x).clamp(-MV_CLAMP, MV_CLAMP),
            y: (p.y + mvd.y).clamp(-MV_CLAMP, MV_CLAMP),
        }
    }

    /// Заполняет ячейки листа после его декодирования/решения.
    pub fn fill_leaf(&mut self, b: Blk, kind: &LeafKind) {
        let (mode, mv) = match *kind {
            LeafKind::Intra { mode, .. } => (mode, Mv::default()),
            LeafKind::Inter { mv, .. } => (MODE_INTER, mv),
        };
        for cy in b.y / 8..(b.y + b.n) / 8 {
            for cx in b.x / 8..(b.x + b.n) / 8 {
                self.modes[cy * self.w8 + cx] = mode;
                self.mvs[cy * self.w8 + cx] = mv;
            }
        }
    }

    /// Снимок ячеек региона (для отката split-проб энкодера).
    pub fn save_region(&self, b: Blk) -> SavedCells {
        let (cx0, cy0) = (b.x / 8, b.y / 8);
        let (cx1, cy1) = (
            ((b.x + b.n) / 8).min(self.w8),
            ((b.y + b.n) / 8).min(self.modes.len() / self.w8),
        );
        let mut modes = Vec::with_capacity((cx1 - cx0) * (cy1 - cy0));
        let mut mvs = Vec::with_capacity((cx1 - cx0) * (cy1 - cy0));
        for cy in cy0..cy1 {
            for cx in cx0..cx1 {
                modes.push(self.modes[cy * self.w8 + cx]);
                mvs.push(self.mvs[cy * self.w8 + cx]);
            }
        }
        SavedCells { modes, mvs }
    }

    pub fn restore_region(&mut self, b: Blk, saved: &SavedCells) {
        let (cx0, cy0) = (b.x / 8, b.y / 8);
        let (cx1, cy1) = (
            ((b.x + b.n) / 8).min(self.w8),
            ((b.y + b.n) / 8).min(self.modes.len() / self.w8),
        );
        let mut i = 0;
        for cy in cy0..cy1 {
            for cx in cx0..cx1 {
                self.modes[cy * self.w8 + cx] = saved.modes[i];
                self.mvs[cy * self.w8 + cx] = saved.mvs[i];
                i += 1;
            }
        }
    }
}

pub struct SavedCells {
    modes: Vec<u8>,
    mvs: Vec<Mv>,
}
