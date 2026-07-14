//! Энкодер FRV1 с RD-оптимизацией разбиения, режимов и векторов движения.
//!
//! Поток решений на суперблок:
//! 1. Рекурсивный RDO: для каждого узла quadtree сравнивается стоимость листа
//!    (лучший из intra-режимов и inter-вариантов) и суммы детей; метрика —
//!    `SSE·λ_den + rate·λ_num`. Реконструкция и контекстная сетка выбранных
//!    листьев обновляются немедленно и откатываются при отказе от поддерева —
//!    контексты RDO в точности совпадают с контекстами декодера.
//! 2. Сериализация дерева в арифметический поток (адаптация вероятностей —
//!    только здесь, зеркально декодеру; сетка сериализации строится заново).
//!
//! GOP: ключ каждые `keyint` кадров; ключи кодируются с qp − 4 (якорь качества).

use crate::block::{
    LeafData, LeafGrid, LeafKind, intra_pred_plane, luma_tile_size, reconstruct_leaf,
};
use crate::ec::BoolEncoder;
use crate::frame::{Frame, Plane};
use crate::header::FrameHeader;
use crate::lf::loop_filter;
use crate::mc::{MV_CLAMP, MVD_MAX, Mv, RefFrame, mc_chroma, mc_luma};
use crate::predict::NUM_MODES;
use crate::quant::{ac_step, dequantize_block, quantize_block};
use crate::rate::RateControl;
use crate::syntax::SyntaxModel;
use crate::transform::{forward, inverse};
use crate::{Blk, EncoderConfig, Error, NodePlacement, SB_SIZE, place_node};

/// Закодированный кадр.
#[derive(Debug, Clone)]
pub struct EncodedFrame {
    pub data: Vec<u8>,
    pub keyframe: bool,
}

enum Node {
    Leaf(LeafData),
    Split([Option<Box<Node>>; 4]),
}

/// λ как рациональное число: cost = sse·den + rate256·num.
/// Вывод: высокоскоростная аппроксимация D(R) даёт λ ≈ 0.115·Δ², Δ = step/8 пикселей;
/// на 1/256 бита: λ₂₅₆ = 0.115·step²/64/256 ≈ step²/142000.
#[inline]
fn lambda(qp: u8) -> (u64, u64) {
    let step = ac_step(qp) as u64;
    ((step * step).max(1), 142_000)
}

pub struct Encoder {
    cfg: EncoderConfig,
    recon: Frame,
    reference: Option<RefFrame>,
    frame_index: u64,
    rate_ctrl: Option<RateControl>,
}

impl Encoder {
    pub fn new(cfg: EncoderConfig) -> Result<Self, Error> {
        cfg.validate()?;
        let rate_ctrl = cfg
            .target_kbps
            .map(|kbps| RateControl::new(cfg.qp, kbps, cfg.fps_num, cfg.fps_den));
        Ok(Encoder {
            cfg,
            recon: Frame::new(cfg.width as usize, cfg.height as usize),
            reference: None,
            frame_index: 0,
            rate_ctrl,
        })
    }

    pub fn config(&self) -> &EncoderConfig {
        &self.cfg
    }

    /// Реконструкция последнего закодированного кадра (после деблокинга) —
    /// в точности то, что восстановит декодер.
    pub fn last_recon(&self) -> &Frame {
        &self.recon
    }

    pub fn encode_frame(&mut self, src: &Frame) -> Result<EncodedFrame, Error> {
        let (w, h) = (self.cfg.width as usize, self.cfg.height as usize);
        if src.width() != w || src.height() != h {
            return Err(Error::InvalidFrame(
                "frame dimensions do not match encoder config",
            ));
        }
        let keyframe =
            self.reference.is_none() || self.frame_index.is_multiple_of(u64::from(self.cfg.keyint));
        let base_qp = self
            .rate_ctrl
            .as_ref()
            .map(RateControl::qp)
            .unwrap_or(self.cfg.qp);
        // Ключевой кадр — якорь GOP: чуть мельче квант.
        let qp = if keyframe && self.cfg.keyint > 1 {
            base_qp.saturating_sub(4)
        } else {
            base_qp
        };
        let (lambda_num, lambda_den) = lambda(qp);

        let mut fe = FrameEnc {
            src,
            reference: if keyframe {
                None
            } else {
                self.reference.as_ref()
            },
            keyframe,
            qp,
            lambda_num,
            lambda_den,
            recon: Frame::new(w, h),
            grid: LeafGrid::new(w, h),
            ssim_tune: self.cfg.ssim_tune,
        };
        // Кадровые модели/сетка сериализации (зеркало декодера).
        let mut syntax = SyntaxModel::default();
        let mut ser_grid = LeafGrid::new(w, h);
        let mut enc = BoolEncoder::new();

        for sb_y in (0..h).step_by(SB_SIZE) {
            for sb_x in (0..w).step_by(SB_SIZE) {
                let sb = Blk {
                    x: sb_x,
                    y: sb_y,
                    n: SB_SIZE,
                };
                let (_, tree) = fe
                    .rdo_node(&syntax, sb, None)
                    .expect("superblock origin is inside the frame");
                fe.serialize_node(&mut enc, &mut syntax, &mut ser_grid, sb, &tree);
            }
        }

        let header = FrameHeader {
            keyframe,
            loop_filter: self.cfg.loop_filter,
            qp,
            width: self.cfg.width,
            height: self.cfg.height,
        };
        let mut data = Vec::new();
        header.write(&mut data);
        data.extend_from_slice(&enc.finish());

        if let Some(rc) = &mut self.rate_ctrl {
            rc.update(data.len());
        }

        let mut recon = fe.recon;
        if self.cfg.loop_filter {
            loop_filter(&mut recon, qp);
        }
        self.recon = recon;
        self.reference = Some(RefFrame::new(self.recon.clone()));
        self.frame_index += 1;
        Ok(EncodedFrame { data, keyframe })
    }
}

/// Результат RDO листа.
struct LeafOutcome {
    cost: u64,
    dist: u64,
    leaf: LeafData,
}

/// Состояние кодирования одного кадра.
struct FrameEnc<'a> {
    src: &'a Frame,
    reference: Option<&'a RefFrame>,
    keyframe: bool,
    qp: u8,
    lambda_num: u64,
    lambda_den: u64,
    recon: Frame,
    /// Контекстная сетка RDO: заполняется по мере принятия решений,
    /// откатывается вместе с пикселями при отказе от поддерева.
    grid: LeafGrid,
    ssim_tune: bool,
}

impl FrameEnc<'_> {
    /// RDO узла. Возвращает `None` для узлов вне кадра.
    /// Пишет реконструкцию и сетку выбранного поддерева.
    fn rdo_node(&mut self, syntax: &SyntaxModel, b: Blk, hint: Option<Mv>) -> Option<(u64, Node)> {
        match place_node(b, self.src.width(), self.src.height()) {
            NodePlacement::Outside => None,
            NodePlacement::MustSplit => {
                let (cost, children) = self.rdo_split(syntax, b, hint);
                Some((cost, Node::Split(children)))
            }
            NodePlacement::Leaf => {
                let out = self.rdo_leaf(syntax, b, hint);
                self.commit_leaf(b, &out.leaf);
                Some((out.cost, Node::Leaf(out.leaf)))
            }
            NodePlacement::Choice => {
                let leaf_flag = syntax.split_cost(b.n, false) * self.lambda_num;
                let split_flag = syntax.split_cost(b.n, true) * self.lambda_num;
                let out = self.rdo_leaf(syntax, b, hint);
                let leaf_cost = out.cost + leaf_flag;

                // Прунинг: идеальный лист дешевле любого разбиения
                // (у split минимум 4 листа синтаксиса против одного).
                if out.dist == 0 {
                    self.commit_leaf(b, &out.leaf);
                    return Some((leaf_cost, Node::Leaf(out.leaf)));
                }

                let saved_px = save_region(&self.recon, b);
                let saved_cells = self.grid.save_region(b);
                let child_hint = match out.leaf.kind {
                    LeafKind::Inter { mv, .. } => Some(mv),
                    LeafKind::Intra { .. } => hint,
                };
                let (split_cost, children) = self.rdo_split(syntax, b, child_hint);
                let split_cost = split_cost + split_flag;

                if leaf_cost <= split_cost {
                    restore_region(&mut self.recon, b, &saved_px);
                    self.grid.restore_region(b, &saved_cells);
                    self.commit_leaf(b, &out.leaf);
                    Some((leaf_cost, Node::Leaf(out.leaf)))
                } else {
                    Some((split_cost, Node::Split(children)))
                }
            }
        }
    }

    fn rdo_split(
        &mut self,
        syntax: &SyntaxModel,
        b: Blk,
        hint: Option<Mv>,
    ) -> (u64, [Option<Box<Node>>; 4]) {
        let mut cost = 0u64;
        let mut children: [Option<Box<Node>>; 4] = [None, None, None, None];
        for (i, child) in children.iter_mut().enumerate() {
            if let Some((c, node)) = self.rdo_node(syntax, b.child(i), hint) {
                cost += c;
                *child = Some(Box::new(node));
            }
        }
        (cost, children)
    }

    /// Пишет реконструкцию листа и обновляет RDO-сетку.
    fn commit_leaf(&mut self, b: Blk, leaf: &LeafData) {
        reconstruct_leaf(&mut self.recon, self.reference, b, leaf, self.qp);
        self.grid.fill_leaf(b, &leaf.kind);
    }

    /// Выбор способа кодирования листа: inter (skip / с остатком) против intra.
    fn rdo_leaf(&self, syntax: &SyntaxModel, b: Blk, hint: Option<Mv>) -> LeafOutcome {
        let inter = self.rdo_leaf_inter(syntax, b, hint);
        // Идеальный skip: intra не догонит (минимальный синтаксис, нулевая дисторсия).
        if let Some(o) = &inter
            && o.dist == 0
        {
            return inter.expect("checked above");
        }
        let intra = self.rdo_leaf_intra(syntax, b);
        match inter {
            Some(o) if o.cost <= intra.cost => o,
            _ => intra,
        }
    }

    // ------------------------------------------------------------------
    // Inter
    // ------------------------------------------------------------------

    fn rdo_leaf_inter(
        &self,
        syntax: &SyntaxModel,
        b: Blk,
        hint: Option<Mv>,
    ) -> Option<LeafOutcome> {
        let reference = self.reference?;
        let pred_mv = self.grid.mv_predictor(b.x, b.y, b.n);
        let bc = b.chroma();
        let inter_bit = syntax.is_inter_cost(self.grid.inter_ctx(b.x, b.y), true) * self.lambda_num;

        // Вариант skip: MV = предиктор, без остатка.
        let mut pred = [0i32; 64 * 64];
        let mut skip_dist = 0u64;
        mc_luma(&reference.y, b, pred_mv, &mut pred);
        skip_dist += plane_pred_dist(&self.src.y, b, &pred, self.ssim_tune);
        mc_chroma(&reference.cb, bc, pred_mv, &mut pred);
        skip_dist += plane_pred_dist(&self.src.cb, bc, &pred, self.ssim_tune);
        mc_chroma(&reference.cr, bc, pred_mv, &mut pred);
        skip_dist += plane_pred_dist(&self.src.cr, bc, &pred, self.ssim_tune);
        let skip_rate =
            inter_bit + (syntax.mvd_cost(Mv::default()) + syntax.skip_cost(true)) * self.lambda_num;
        let skip_cost = skip_dist * self.lambda_den + skip_rate;
        let skip_leaf = LeafData {
            kind: LeafKind::Inter {
                mv: pred_mv,
                skip: true,
            },
            tx_split: false,
            luma: Vec::new(),
            cb: Vec::new(),
            cr: Vec::new(),
        };
        // Идеальная статика: дальше не ищем.
        if skip_dist == 0 {
            return Some(LeafOutcome {
                cost: skip_cost,
                dist: 0,
                leaf: skip_leaf,
            });
        }

        // Поиск движения и вариант с остатком.
        let mv = self.motion_search(reference, b, pred_mv, hint);
        let mut best: Option<LeafOutcome> = None;
        for tx_split in [false, true] {
            let out = self.trial_leaf_inter(syntax, b, reference, pred_mv, mv, tx_split);
            if best.as_ref().is_none_or(|bo| out.cost < bo.cost) {
                best = Some(out);
            }
        }
        let coded = best.expect("two tx variants tried");
        if skip_cost <= coded.cost {
            Some(LeafOutcome {
                cost: skip_cost,
                dist: skip_dist,
                leaf: skip_leaf,
            })
        } else {
            Some(coded)
        }
    }

    /// Кодирование inter-листа с остатком при заданных MV и размере трансформа.
    fn trial_leaf_inter(
        &self,
        syntax: &SyntaxModel,
        b: Blk,
        reference: &RefFrame,
        pred_mv: Mv,
        mv: Mv,
        tx_split: bool,
    ) -> LeafOutcome {
        let bc = b.chroma();
        let mvd = Mv {
            x: mv.x - pred_mv.x,
            y: mv.y - pred_mv.y,
        };
        let mut rate = syntax.is_inter_cost(self.grid.inter_ctx(b.x, b.y), true)
            + syntax.mvd_cost(mvd)
            + syntax.skip_cost(false)
            + syntax.tx_split_cost(b.n, tx_split);
        let mut dist = 0u64;
        let mut pred = [0i32; 64 * 64];

        mc_luma(&reference.y, b, mv, &mut pred);
        let (d, r, luma) = self.trial_plane(
            syntax,
            &self.src.y,
            &pred,
            b,
            luma_tile_size(b.n, tx_split),
            0,
        );
        dist += d;
        rate += r;
        mc_chroma(&reference.cb, bc, mv, &mut pred);
        let (d, r, cb) = self.trial_plane(syntax, &self.src.cb, &pred, bc, bc.n, 1);
        dist += d;
        rate += r;
        mc_chroma(&reference.cr, bc, mv, &mut pred);
        let (d, r, cr) = self.trial_plane(syntax, &self.src.cr, &pred, bc, bc.n, 1);
        dist += d;
        rate += r;

        LeafOutcome {
            cost: dist * self.lambda_den + rate * self.lambda_num,
            dist,
            leaf: LeafData {
                kind: LeafKind::Inter { mv, skip: false },
                tx_split,
                luma,
                cb: cb.into_iter().next().expect("chroma has exactly one tile"),
                cr: cr.into_iter().next().expect("chroma has exactly one tile"),
            },
        }
    }

    /// Поиск вектора движения: целопиксельный log-поиск + суб-пиксельное уточнение.
    /// Возвращает MV, удовлетворяющий ограничениям синтаксиса (|mvd| ≤ 2047).
    fn motion_search(&self, reference: &RefFrame, b: Blk, pred_mv: Mv, hint: Option<Mv>) -> Mv {
        let rp = &reference.y;
        let clamp_mv = |m: Mv| Mv {
            x: (pred_mv.x + (m.x - pred_mv.x).clamp(-(MVD_MAX - 64), MVD_MAX - 64))
                .clamp(-MV_CLAMP, MV_CLAMP),
            y: (pred_mv.y + (m.y - pred_mv.y).clamp(-(MVD_MAX - 64), MVD_MAX - 64))
                .clamp(-MV_CLAMP, MV_CLAMP),
        };
        let full = |m: Mv| Mv {
            x: (m.x >> 2) << 2,
            y: (m.y >> 2) << 2,
        };

        let mut best_mv = Mv::default();
        let mut best_sad = self.sad_fullpel(rp, b, best_mv);
        let consider = |m: Mv, best_mv: &mut Mv, best_sad: &mut u64, s: &Self| {
            let m = clamp_mv(m);
            let sad = s.sad_fullpel(rp, b, m);
            if sad < *best_sad {
                *best_sad = sad;
                *best_mv = m;
            }
        };
        consider(full(pred_mv), &mut best_mv, &mut best_sad, self);
        if let Some(hm) = hint {
            consider(full(hm), &mut best_mv, &mut best_sad, self);
        }

        // Целопиксельный итеративный ромб с убывающим шагом.
        for step_px in [16i32, 8, 4, 2, 1] {
            let step = step_px * 4;
            for _ in 0..12 {
                let base = best_mv;
                for (dx, dy) in [(-step, 0), (step, 0), (0, -step), (0, step)] {
                    consider(
                        Mv {
                            x: base.x + dx,
                            y: base.y + dy,
                        },
                        &mut best_mv,
                        &mut best_sad,
                        self,
                    );
                }
                if best_mv == base {
                    break;
                }
            }
        }

        // Суб-пиксельное уточнение: ½, затем ¼ (SAD по интерполяции).
        let mut best_sub = self.sad_subpel(rp, b, best_mv);
        for step in [2, 1] {
            for _ in 0..4 {
                let base = best_mv;
                for (dx, dy) in [
                    (-step, 0),
                    (step, 0),
                    (0, -step),
                    (0, step),
                    (-step, -step),
                    (step, step),
                    (-step, step),
                    (step, -step),
                ] {
                    let m = clamp_mv(Mv {
                        x: base.x + dx,
                        y: base.y + dy,
                    });
                    let sad = self.sad_subpel(rp, b, m);
                    if sad < best_sub {
                        best_sub = sad;
                        best_mv = m;
                    }
                }
                if best_mv == base {
                    break;
                }
            }
        }
        best_mv
    }

    /// SAD целопиксельного кандидата (быстрый путь без интерполяции).
    fn sad_fullpel(&self, rp: &crate::mc::PadPlane, b: Blk, mv: Mv) -> u64 {
        debug_assert!(mv.x % 4 == 0 && mv.y % 4 == 0);
        // Тот же кламп позиции, что и в mc_luma (фаза 0).
        let px = (4 * b.x as i32 + mv.x).clamp(
            -4 * (crate::mc::LUMA_BORDER as i32 - 3),
            4 * (rp.width() as i32 - b.n as i32 + crate::mc::LUMA_BORDER as i32 - 3),
        );
        let py = (4 * b.y as i32 + mv.y).clamp(
            -4 * (crate::mc::LUMA_BORDER as i32 - 3),
            4 * (rp.height() as i32 - b.n as i32 + crate::mc::LUMA_BORDER as i32 - 3),
        );
        let (x0, y0) = ((px >> 2) as isize, (py >> 2) as isize);
        let mut sad = 0u64;
        for r in 0..b.n {
            for c in 0..b.n {
                let s = i32::from(self.src.y.get(b.x + c, b.y + r));
                let p = i32::from(rp.at(x0 + c as isize, y0 + r as isize));
                sad += s.abs_diff(p) as u64;
            }
        }
        sad
    }

    /// SAD суб-пиксельного кандидата (через нормативную интерполяцию).
    fn sad_subpel(&self, rp: &crate::mc::PadPlane, b: Blk, mv: Mv) -> u64 {
        let mut pred = [0i32; 64 * 64];
        mc_luma(rp, b, mv, &mut pred);
        let mut sad = 0u64;
        for r in 0..b.n {
            for c in 0..b.n {
                let s = i32::from(self.src.y.get(b.x + c, b.y + r));
                sad += s.abs_diff(pred[r * b.n + c]) as u64;
            }
        }
        sad
    }

    // ------------------------------------------------------------------
    // Intra
    // ------------------------------------------------------------------

    /// Intra-лист: SAD-преселект люма-режимов → полный RD топ-3 → выбор
    /// хрома-режима → финал с RDOQ при обоих размерах трансформа.
    fn rdo_leaf_intra(&self, syntax: &SyntaxModel, b: Blk) -> LeafOutcome {
        let dir_ctx = self.grid.dir_ctx(b.x, b.y);
        let bc = b.chroma();
        let inter_bit = if self.keyframe {
            0
        } else {
            syntax.is_inter_cost(self.grid.inter_ctx(b.x, b.y), false)
        };

        // Этап A: SAD-преселект по люме.
        let mut pred = [0i32; 64 * 64];
        let mut ranked: Vec<(u64, u8)> = (0..NUM_MODES as u8)
            .map(|mode| {
                intra_pred_plane(&self.recon.y, b, true, mode, &mut pred);
                (sad_pred(&self.src.y, b, &pred), mode)
            })
            .collect();
        ranked.sort_unstable();

        // Этап B: полный RD (без RDOQ) для топ-3, хрома = режим люмы.
        let tsize = luma_tile_size(b.n, false);
        let mut best_mode = ranked[0].1;
        let mut best_cost = u64::MAX;
        for &(_, mode) in ranked.iter().take(3) {
            let mut dist = 0u64;
            let mut rate = inter_bit
                + syntax.mode_cost(dir_ctx, mode)
                + syntax.chroma_mode_cost(None)
                + syntax.tx_split_cost(b.n, false);
            intra_pred_plane(&self.recon.y, b, true, mode, &mut pred);
            let (d, r, _) = self.trial_plane(syntax, &self.src.y, &pred, b, tsize, 0);
            dist += d;
            rate += r;
            let (d, r, _, _) = self.trial_chroma(syntax, bc, mode);
            dist += d;
            rate += r;
            let cost = dist * self.lambda_den + rate * self.lambda_num;
            if cost < best_cost {
                best_cost = cost;
                best_mode = mode;
            }
        }

        // Этап C: хрома-режим (same против DC/TM/V/H).
        let mut best_cm: Option<u8> = None;
        let mut best_chroma = u64::MAX;
        for cm in [
            None,
            Some(crate::predict::MODE_DC),
            Some(crate::predict::MODE_TM),
            Some(crate::predict::MODE_V),
            Some(crate::predict::MODE_H),
        ] {
            if cm == Some(best_mode) {
                continue; // покрывается вариантом `same`
            }
            let cmode = cm.unwrap_or(best_mode);
            let (d, r, _, _) = self.trial_chroma(syntax, bc, cmode);
            let cost = d * self.lambda_den + (r + syntax.chroma_mode_cost(cm)) * self.lambda_num;
            if cost < best_chroma {
                best_chroma = cost;
                best_cm = cm;
            }
        }

        // Этап D: финал с RDOQ, оба размера трансформа люмы.
        let cmode = best_cm.unwrap_or(best_mode);
        let mut best: Option<LeafOutcome> = None;
        for tx_split in [false, true] {
            let mut dist = 0u64;
            let mut rate = inter_bit
                + syntax.mode_cost(dir_ctx, best_mode)
                + syntax.chroma_mode_cost(best_cm)
                + syntax.tx_split_cost(b.n, tx_split);
            intra_pred_plane(&self.recon.y, b, true, best_mode, &mut pred);
            let (d, r, luma) = self.trial_plane_opt(
                syntax,
                &self.src.y,
                &pred,
                b,
                luma_tile_size(b.n, tx_split),
                0,
            );
            dist += d;
            rate += r;
            let (d, r, cb, cr) = self.trial_chroma_opt(syntax, bc, cmode);
            dist += d;
            rate += r;
            let cost = dist * self.lambda_den + rate * self.lambda_num;
            if best.as_ref().is_none_or(|bo| cost < bo.cost) {
                best = Some(LeafOutcome {
                    cost,
                    dist,
                    leaf: LeafData {
                        kind: LeafKind::Intra {
                            mode: best_mode,
                            chroma_mode: best_cm,
                        },
                        tx_split,
                        luma,
                        cb,
                        cr,
                    },
                });
            }
        }
        best.expect("two tx variants tried")
    }

    /// Проба обеих хрома-плоскостей интра-режимом `cmode` (без RDOQ).
    fn trial_chroma(
        &self,
        syntax: &SyntaxModel,
        bc: Blk,
        cmode: u8,
    ) -> (u64, u64, Vec<i32>, Vec<i32>) {
        let mut pred = [0i32; 64 * 64];
        intra_pred_plane(&self.recon.cb, bc, false, cmode, &mut pred);
        let (d1, r1, cb) = self.trial_plane(syntax, &self.src.cb, &pred, bc, bc.n, 1);
        intra_pred_plane(&self.recon.cr, bc, false, cmode, &mut pred);
        let (d2, r2, cr) = self.trial_plane(syntax, &self.src.cr, &pred, bc, bc.n, 1);
        (
            d1 + d2,
            r1 + r2,
            cb.into_iter().next().expect("one tile"),
            cr.into_iter().next().expect("one tile"),
        )
    }

    fn trial_chroma_opt(
        &self,
        syntax: &SyntaxModel,
        bc: Blk,
        cmode: u8,
    ) -> (u64, u64, Vec<i32>, Vec<i32>) {
        let mut pred = [0i32; 64 * 64];
        intra_pred_plane(&self.recon.cb, bc, false, cmode, &mut pred);
        let (d1, r1, cb) = self.trial_plane_opt(syntax, &self.src.cb, &pred, bc, bc.n, 1);
        intra_pred_plane(&self.recon.cr, bc, false, cmode, &mut pred);
        let (d2, r2, cr) = self.trial_plane_opt(syntax, &self.src.cr, &pred, bc, bc.n, 1);
        (
            d1 + d2,
            r1 + r2,
            cb.into_iter().next().expect("one tile"),
            cr.into_iter().next().expect("one tile"),
        )
    }

    /// Кодирование блока плоскости с готовым предсказанием: возвращает
    /// (SSE, rate256, тайлы уровней). Без RDOQ (быстрые пробы).
    fn trial_plane(
        &self,
        syntax: &SyntaxModel,
        src: &Plane,
        pred: &[i32],
        b: Blk,
        tsize: usize,
        pt: usize,
    ) -> (u64, u64, Vec<Vec<i32>>) {
        self.trial_plane_impl(syntax, src, pred, b, tsize, pt, false)
    }

    /// То же с RDOQ (финальные пробы).
    fn trial_plane_opt(
        &self,
        syntax: &SyntaxModel,
        src: &Plane,
        pred: &[i32],
        b: Blk,
        tsize: usize,
        pt: usize,
    ) -> (u64, u64, Vec<Vec<i32>>) {
        self.trial_plane_impl(syntax, src, pred, b, tsize, pt, true)
    }

    #[allow(clippy::too_many_arguments)]
    fn trial_plane_impl(
        &self,
        syntax: &SyntaxModel,
        src: &Plane,
        pred: &[i32],
        b: Blk,
        tsize: usize,
        pt: usize,
        optimize: bool,
    ) -> (u64, u64, Vec<Vec<i32>>) {
        let per_row = b.n / tsize;
        let t2 = tsize * tsize;
        let mut tiles = Vec::with_capacity(per_row * per_row);
        let mut dist = 0u64;
        let mut rate = 0u64;

        let mut res = [0i32; 32 * 32];
        let mut coeffs = [0i32; 32 * 32];
        let mut levels = [0i32; 32 * 32];
        let mut deq = [0i32; 32 * 32];
        let mut rec_res = [0i32; 32 * 32];

        let mut rec_buf = [0i32; 64 * 64];
        for ty in 0..per_row {
            for tx in 0..per_row {
                for i in 0..tsize {
                    for j in 0..tsize {
                        let sy = b.y + ty * tsize + i;
                        let sx = b.x + tx * tsize + j;
                        res[i * tsize + j] = i32::from(src.get(sx, sy))
                            - pred[(ty * tsize + i) * b.n + tx * tsize + j];
                    }
                }
                forward(&res[..t2], tsize, &mut coeffs[..t2]);
                quantize_block(&coeffs[..t2], &mut levels[..t2], self.qp);
                if optimize {
                    syntax.coeffs.optimize_levels(
                        pt,
                        tsize,
                        &coeffs[..t2],
                        &mut levels[..t2],
                        self.qp,
                        self.lambda_num,
                        self.lambda_den,
                    );
                }
                rate += syntax.coeffs.estimate_block(pt, tsize, &levels[..t2]);
                dequantize_block(&levels[..t2], &mut deq[..t2], self.qp);
                inverse(&deq[..t2], tsize, &mut rec_res[..t2]);
                for i in 0..tsize {
                    for j in 0..tsize {
                        let sy = b.y + ty * tsize + i;
                        let sx = b.x + tx * tsize + j;
                        let p = pred[(ty * tsize + i) * b.n + tx * tsize + j];
                        let rec = (p + rec_res[i * tsize + j]).clamp(0, 255);
                        let idx = (ty * tsize + i) * b.n + tx * tsize + j;
                        rec_buf[idx] = rec;
                        let d = i64::from(src.get(sx, sy)) - i64::from(rec);
                        dist += (d * d) as u64;
                    }
                }
                tiles.push(levels[..t2].to_vec());
            }
        }
        if self.ssim_tune {
            dist = blend_sse_ssim(
                dist,
                crate::metrics::block_ssim_dist(src, b, &rec_buf[..b.n * b.n]),
            );
        }
        (dist, rate, tiles)
    }

    // ------------------------------------------------------------------
    // Сериализация (адаптация моделей, зеркало парсера декодера)
    // ------------------------------------------------------------------

    fn serialize_node(
        &self,
        enc: &mut BoolEncoder,
        syntax: &mut SyntaxModel,
        grid: &mut LeafGrid,
        b: Blk,
        node: &Node,
    ) {
        let placement = place_node(b, self.recon.width(), self.recon.height());
        match node {
            Node::Leaf(leaf) => {
                debug_assert!(matches!(
                    placement,
                    NodePlacement::Leaf | NodePlacement::Choice
                ));
                if matches!(placement, NodePlacement::Choice) {
                    syntax.encode_split(enc, b.n, false);
                }
                self.serialize_leaf(enc, syntax, grid, b, leaf);
            }
            Node::Split(children) => {
                if matches!(placement, NodePlacement::Choice) {
                    syntax.encode_split(enc, b.n, true);
                }
                for (i, child) in children.iter().enumerate() {
                    if let Some(child) = child {
                        self.serialize_node(enc, syntax, grid, b.child(i), child);
                    }
                }
            }
        }
    }

    fn serialize_leaf(
        &self,
        enc: &mut BoolEncoder,
        syntax: &mut SyntaxModel,
        grid: &mut LeafGrid,
        b: Blk,
        leaf: &LeafData,
    ) {
        match leaf.kind {
            LeafKind::Inter { mv, skip } => {
                debug_assert!(!self.keyframe);
                syntax.encode_is_inter(enc, grid.inter_ctx(b.x, b.y), true);
                let pred_mv = grid.mv_predictor(b.x, b.y, b.n);
                let mvd = Mv {
                    x: mv.x - pred_mv.x,
                    y: mv.y - pred_mv.y,
                };
                debug_assert!(mvd.x.abs() <= MVD_MAX && mvd.y.abs() <= MVD_MAX);
                syntax.encode_mvd(enc, mvd);
                syntax.encode_skip(enc, skip);
                if !skip {
                    self.serialize_coeffs(enc, syntax, b, leaf);
                }
            }
            LeafKind::Intra { mode, chroma_mode } => {
                if !self.keyframe {
                    syntax.encode_is_inter(enc, grid.inter_ctx(b.x, b.y), false);
                }
                syntax.encode_mode(enc, grid.dir_ctx(b.x, b.y), mode);
                syntax.encode_chroma_mode(enc, chroma_mode);
                self.serialize_coeffs(enc, syntax, b, leaf);
            }
        }
        grid.fill_leaf(b, &leaf.kind);
    }

    fn serialize_coeffs(
        &self,
        enc: &mut BoolEncoder,
        syntax: &mut SyntaxModel,
        b: Blk,
        leaf: &LeafData,
    ) {
        syntax.encode_tx_split(enc, b.n, leaf.tx_split);
        let tsize = luma_tile_size(b.n, leaf.tx_split);
        for tile in &leaf.luma {
            syntax.coeffs.encode_block(enc, 0, tsize, tile);
        }
        let cn = b.n / 2;
        syntax.coeffs.encode_block(enc, 1, cn, &leaf.cb);
        syntax.coeffs.encode_block(enc, 1, cn, &leaf.cr);
    }
}

/// SSE источника против предсказания (без остатка).
#[inline]
fn sse_pred(src: &Plane, b: Blk, pred: &[i32]) -> u64 {
    let n = b.n;
    let mut sse = 0u64;
    let mut j = 0usize;
    while j + 4 <= n {
        for i in 0..n {
            let row = i * n;
            let sy = b.y + i;
            for k in 0..4 {
                let d = i64::from(src.get(b.x + j + k, sy))
                    - i64::from(pred[row + j + k].clamp(0, 255));
                sse += (d * d) as u64;
            }
        }
        j += 4;
    }
    for i in 0..n {
        for jj in j..n {
            let d =
                i64::from(src.get(b.x + jj, b.y + i)) - i64::from(pred[i * n + jj].clamp(0, 255));
            sse += (d * d) as u64;
        }
    }
    sse
}

/// Дисторсия предсказания с опциональным SSIM-RDO.
#[inline]
fn plane_pred_dist(src: &Plane, b: Blk, pred: &[i32], ssim_tune: bool) -> u64 {
    let sse = sse_pred(src, b, pred);
    if ssim_tune {
        blend_sse_ssim(sse, crate::metrics::block_ssim_dist(src, b, pred))
    } else {
        sse
    }
}

/// Смешивание SSE и SSIM-прокси (вес SSIM ≈ 22%).
#[inline]
fn blend_sse_ssim(sse: u64, ssim: u64) -> u64 {
    const W: u64 = 56;
    sse * (256 - W) / 256 + ssim * W / 256
}

/// SAD источника против предсказания.
#[inline]
fn sad_pred(src: &Plane, b: Blk, pred: &[i32]) -> u64 {
    let n = b.n;
    let mut sad = 0u64;
    let mut j = 0usize;
    while j + 4 <= n {
        for i in 0..n {
            let row = i * n;
            let sy = b.y + i;
            for k in 0..4 {
                let s = i32::from(src.get(b.x + j + k, sy));
                sad += s.abs_diff(pred[row + j + k].clamp(0, 255)) as u64;
            }
        }
        j += 4;
    }
    for i in 0..n {
        for jj in j..n {
            let s = i32::from(src.get(b.x + jj, b.y + i));
            sad += s.abs_diff(pred[i * n + jj].clamp(0, 255)) as u64;
        }
    }
    sad
}

struct SavedRegion {
    y: Vec<u8>,
    cb: Vec<u8>,
    cr: Vec<u8>,
}

fn save_plane_region(p: &Plane, b: Blk) -> Vec<u8> {
    let nx = b.n.min(p.width() - b.x);
    let ny = b.n.min(p.height() - b.y);
    let mut out = Vec::with_capacity(nx * ny);
    for i in 0..ny {
        out.extend_from_slice(&p.row(b.y + i)[b.x..b.x + nx]);
    }
    out
}

fn restore_plane_region(p: &mut Plane, b: Blk, saved: &[u8]) {
    let nx = b.n.min(p.width() - b.x);
    let ny = b.n.min(p.height() - b.y);
    for i in 0..ny {
        for j in 0..nx {
            p.set(b.x + j, b.y + i, saved[i * nx + j]);
        }
    }
}

fn save_region(f: &Frame, b: Blk) -> SavedRegion {
    SavedRegion {
        y: save_plane_region(&f.y, b),
        cb: save_plane_region(&f.cb, b.chroma()),
        cr: save_plane_region(&f.cr, b.chroma()),
    }
}

fn restore_region(f: &mut Frame, b: Blk, saved: &SavedRegion) {
    restore_plane_region(&mut f.y, b, &saved.y);
    restore_plane_region(&mut f.cb, b.chroma(), &saved.cb);
    restore_plane_region(&mut f.cr, b.chroma(), &saved.cr);
}
