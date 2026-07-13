//! Энкодер FVC1 v0.1 (intra-only) с RD-оптимизацией разбиения и режимов.
//!
//! Поток решений на суперблок:
//! 1. Рекурсивный RDO: для каждого узла quadtree сравнивается стоимость листа
//!    (лучший из 4 режимов) и суммы детей; метрика — `SSE·λ_den + rate·λ_num`.
//! 2. Реконструкция выбранных листьев пишется в кадр немедленно (соседние блоки
//!    предсказываются от финальных пикселей — как увидит их декодер).
//! 3. Сериализация дерева в арифметический поток (адаптация моделей — только здесь,
//!    зеркально декодеру).

use crate::block::{LeafData, ModeGrid, luma_tile_size, reconstruct_plane_block};
use crate::ec::BoolEncoder;
use crate::frame::{Frame, Plane};
use crate::header::FrameHeader;
use crate::lf::loop_filter;
use crate::predict::{CHROMA_GRID, LUMA_GRID, NUM_MODES, RefGrid, Refs, predict};
use crate::quant::{ac_step, dequantize_block, quantize_block};
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
    lambda_num: u64,
    lambda_den: u64,
}

impl Encoder {
    pub fn new(cfg: EncoderConfig) -> Result<Self, Error> {
        cfg.validate()?;
        let (num, den) = lambda(cfg.qp);
        Ok(Encoder {
            cfg,
            recon: Frame::new(cfg.width as usize, cfg.height as usize),
            lambda_num: num,
            lambda_den: den,
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
        // Кадры независимы: свежая реконструкция и модели.
        self.recon = Frame::new(w, h);
        let mut syntax = SyntaxModel::default();
        let mut grid = ModeGrid::new(w, h);
        let mut enc = BoolEncoder::new();

        let qp = self.cfg.qp;
        for sb_y in (0..h).step_by(SB_SIZE) {
            for sb_x in (0..w).step_by(SB_SIZE) {
                let sb = Blk {
                    x: sb_x,
                    y: sb_y,
                    n: SB_SIZE,
                };
                let (_, tree) = self
                    .rdo_node(src, &syntax, &grid, sb, qp)
                    .expect("superblock origin is inside the frame");
                self.serialize_node(&mut enc, &mut syntax, &mut grid, sb, &tree);
            }
        }

        let header = FrameHeader {
            keyframe: true,
            loop_filter: self.cfg.loop_filter,
            qp,
            width: self.cfg.width,
            height: self.cfg.height,
        };
        let mut data = Vec::new();
        header.write(&mut data);
        data.extend_from_slice(&enc.finish());

        if self.cfg.loop_filter {
            loop_filter(&mut self.recon, qp);
        }
        Ok(EncodedFrame {
            data,
            keyframe: true,
        })
    }

    /// RDO узла. Возвращает `None` для узлов вне кадра.
    /// Пишет реконструкцию выбранного поддерева в `self.recon`.
    fn rdo_node(
        &mut self,
        src: &Frame,
        syntax: &SyntaxModel,
        grid: &ModeGrid,
        b: Blk,
        qp: u8,
    ) -> Option<(u64, Node)> {
        match place_node(b, src.width(), src.height()) {
            NodePlacement::Outside => None,
            NodePlacement::MustSplit => {
                let (cost, children) = self.rdo_split(src, syntax, grid, b, qp);
                Some((cost, Node::Split(children)))
            }
            NodePlacement::Leaf => {
                let (cost, leaf) = self.rdo_leaf(src, syntax, grid, b, qp);
                self.write_leaf(b, &leaf, qp);
                Some((cost, Node::Leaf(leaf)))
            }
            NodePlacement::Choice => {
                let leaf_flag = syntax.split_cost(b.n, false);
                let split_flag = syntax.split_cost(b.n, true);
                let (leaf_cost, leaf) = self.rdo_leaf(src, syntax, grid, b, qp);
                let leaf_cost = leaf_cost + leaf_flag * self.lambda_num;

                let saved = save_region(&self.recon, b);
                let (split_cost, children) = self.rdo_split(src, syntax, grid, b, qp);
                let split_cost = split_cost + split_flag * self.lambda_num;

                if leaf_cost <= split_cost {
                    restore_region(&mut self.recon, b, &saved);
                    self.write_leaf(b, &leaf, qp);
                    Some((leaf_cost, Node::Leaf(leaf)))
                } else {
                    Some((split_cost, Node::Split(children)))
                }
            }
        }
    }

    fn rdo_split(
        &mut self,
        src: &Frame,
        syntax: &SyntaxModel,
        grid: &ModeGrid,
        b: Blk,
        qp: u8,
    ) -> (u64, [Option<Box<Node>>; 4]) {
        let mut cost = 0u64;
        let mut children: [Option<Box<Node>>; 4] = [None, None, None, None];
        for (i, child) in children.iter_mut().enumerate() {
            if let Some((c, node)) = self.rdo_node(src, syntax, grid, b.child(i), qp) {
                cost += c;
                *child = Some(Box::new(node));
            }
        }
        (cost, children)
    }

    /// Пробует все режимы листа, возвращает (cost, данные листа). Реконструкцию не пишет.
    ///
    /// Три прохода: быстрый перебор режимов без RDOQ, затем лучший режим —
    /// с RD-оптимизацией уровней при базовом и половинном размере трансформа.
    fn rdo_leaf(
        &self,
        src: &Frame,
        syntax: &SyntaxModel,
        grid: &ModeGrid,
        b: Blk,
        qp: u8,
    ) -> (u64, LeafData) {
        let dir_ctx = grid.dir_ctx(b.x, b.y);
        let mut best: Option<(u64, u8)> = None;
        for mode in 0..NUM_MODES as u8 {
            let (cost, _) = self.trial_leaf(src, syntax, dir_ctx, b, qp, mode, false, false);
            if best.is_none_or(|(bcost, _)| cost < bcost) {
                best = Some((cost, mode));
            }
        }
        let (_, mode) = best.expect("NUM_MODES > 0");
        let base = self.trial_leaf(src, syntax, dir_ctx, b, qp, mode, false, true);
        let split = self.trial_leaf(src, syntax, dir_ctx, b, qp, mode, true, true);
        if split.0 < base.0 { split } else { base }
    }

    /// Полная стоимость листа одним режимом (все три плоскости + биты режима).
    #[allow(clippy::too_many_arguments)]
    fn trial_leaf(
        &self,
        src: &Frame,
        syntax: &SyntaxModel,
        dir_ctx: usize,
        b: Blk,
        qp: u8,
        mode: u8,
        tx_split: bool,
        optimize: bool,
    ) -> (u64, LeafData) {
        let bc = b.chroma();
        let trial = PlaneTrial {
            mode,
            qp,
            syntax,
            optimize,
            lambda_num: self.lambda_num,
            lambda_den: self.lambda_den,
        };
        let mut rate = (syntax.mode_cost(dir_ctx, mode) + syntax.tx_split_cost(b.n, tx_split))
            * self.lambda_num;
        let mut dist = 0u64;
        let (d, r, luma) = trial.run(
            &src.y,
            &self.recon.y,
            b,
            LUMA_GRID,
            luma_tile_size(b.n, tx_split),
            0,
        );
        dist += d;
        rate += r * self.lambda_num;
        let (d, r, cb) = trial.run(&src.cb, &self.recon.cb, bc, CHROMA_GRID, bc.n, 1);
        dist += d;
        rate += r * self.lambda_num;
        let (d, r, cr) = trial.run(&src.cr, &self.recon.cr, bc, CHROMA_GRID, bc.n, 1);
        dist += d;
        rate += r * self.lambda_num;
        (
            dist * self.lambda_den + rate,
            LeafData {
                mode,
                tx_split,
                luma,
                cb: cb.into_iter().next().expect("chroma has exactly one tile"),
                cr: cr.into_iter().next().expect("chroma has exactly one tile"),
            },
        )
    }

    /// Пишет финальную реконструкцию листа в `self.recon`.
    fn write_leaf(&mut self, b: Blk, leaf: &LeafData, qp: u8) {
        reconstruct_plane_block(
            &mut self.recon.y,
            b,
            LUMA_GRID,
            luma_tile_size(b.n, leaf.tx_split),
            leaf.mode,
            &leaf.luma,
            qp,
        );
        let bc = b.chroma();
        reconstruct_plane_block(
            &mut self.recon.cb,
            bc,
            CHROMA_GRID,
            bc.n,
            leaf.mode,
            std::slice::from_ref(&leaf.cb),
            qp,
        );
        reconstruct_plane_block(
            &mut self.recon.cr,
            bc,
            CHROMA_GRID,
            bc.n,
            leaf.mode,
            std::slice::from_ref(&leaf.cr),
            qp,
        );
    }

    /// Сериализация дерева решений (единственное место адаптации моделей).
    fn serialize_node(
        &self,
        enc: &mut BoolEncoder,
        syntax: &mut SyntaxModel,
        grid: &mut ModeGrid,
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
                syntax.encode_mode(enc, grid.dir_ctx(b.x, b.y), leaf.mode);
                syntax.encode_tx_split(enc, b.n, leaf.tx_split);
                grid.fill(b.x, b.y, b.n, leaf.mode);
                let tsize = luma_tile_size(b.n, leaf.tx_split);
                for tile in &leaf.luma {
                    syntax.coeffs.encode_block(enc, 0, tsize, tile);
                }
                let cn = b.n / 2;
                syntax.coeffs.encode_block(enc, 1, cn, &leaf.cb);
                syntax.coeffs.encode_block(enc, 1, cn, &leaf.cr);
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
}

/// Пробное кодирование блока одной плоскости одним режимом.
struct PlaneTrial<'a> {
    mode: u8,
    qp: u8,
    syntax: &'a SyntaxModel,
    /// RD-оптимизация уровней (только для финального прохода выбранного режима).
    optimize: bool,
    lambda_num: u64,
    lambda_den: u64,
}

impl PlaneTrial<'_> {
    /// Возвращает (SSE, rate256, тайлы квантованных уровней).
    fn run(
        &self,
        src: &Plane,
        recon: &Plane,
        b: Blk,
        g: RefGrid,
        tsize: usize,
        pt: usize,
    ) -> (u64, u64, Vec<Vec<i32>>) {
        let refs = Refs::gather(recon, b.x, b.y, b.n, g);
        let mut pred = [0i32; 64 * 64];
        predict(self.mode, &refs, b.n, &mut pred);

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
                if self.optimize {
                    self.syntax.coeffs.optimize_levels(
                        pt,
                        tsize,
                        &coeffs[..t2],
                        &mut levels[..t2],
                        self.qp,
                        self.lambda_num,
                        self.lambda_den,
                    );
                }
                rate += self.syntax.coeffs.estimate_block(pt, tsize, &levels[..t2]);
                dequantize_block(&levels[..t2], &mut deq[..t2], self.qp);
                inverse(&deq[..t2], tsize, &mut rec_res[..t2]);
                for i in 0..tsize {
                    for j in 0..tsize {
                        let sy = b.y + ty * tsize + i;
                        let sx = b.x + tx * tsize + j;
                        let p = pred[(ty * tsize + i) * b.n + tx * tsize + j];
                        let rec = (p + rec_res[i * tsize + j]).clamp(0, 255);
                        let d = i64::from(src.get(sx, sy)) - i64::from(rec);
                        dist += (d * d) as u64;
                    }
                }
                tiles.push(levels[..t2].to_vec());
            }
        }
        (dist, rate, tiles)
    }
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
