//! Декодер FVC1 v0.1.
//!
//! Никогда не паникует на произвольном входе: структурные ошибки → `Err`,
//! осмысленно-повреждённый арифметический поток → мусорное, но безопасное изображение
//! (все пути реконструкции клампированы, счётчики синтаксиса конечны).

use crate::block::{ModeGrid, luma_tile_size, reconstruct_plane_block};
use crate::ec::BoolDecoder;
use crate::frame::Frame;
use crate::header::FrameHeader;
use crate::lf::loop_filter;
use crate::predict::{CHROMA_GRID, LUMA_GRID};
use crate::syntax::SyntaxModel;
use crate::{Blk, Error, NodePlacement, SB_SIZE, place_node};

#[derive(Default)]
pub struct Decoder {}

impl Decoder {
    pub fn new() -> Self {
        Decoder {}
    }

    pub fn decode_frame(&mut self, data: &[u8]) -> Result<Frame, Error> {
        let (header, payload) = FrameHeader::parse(data)?;
        let (w, h) = (header.width as usize, header.height as usize);
        let mut frame = Frame::new(w, h);
        let mut syntax = SyntaxModel::default();
        let mut grid = ModeGrid::new(w, h);
        let mut dec = BoolDecoder::new(payload);

        for sb_y in (0..h).step_by(SB_SIZE) {
            for sb_x in (0..w).step_by(SB_SIZE) {
                let sb = Blk {
                    x: sb_x,
                    y: sb_y,
                    n: SB_SIZE,
                };
                parse_node(&mut frame, &mut syntax, &mut grid, &mut dec, sb, header.qp);
            }
        }
        if header.loop_filter {
            loop_filter(&mut frame, header.qp);
        }
        Ok(frame)
    }
}

fn parse_node(
    frame: &mut Frame,
    syntax: &mut SyntaxModel,
    grid: &mut ModeGrid,
    dec: &mut BoolDecoder<'_>,
    b: Blk,
    qp: u8,
) {
    let split = match place_node(b, frame.width(), frame.height()) {
        NodePlacement::Outside => return,
        NodePlacement::MustSplit => true,
        NodePlacement::Leaf => false,
        NodePlacement::Choice => syntax.decode_split(dec, b.n),
    };
    if split {
        for i in 0..4 {
            parse_node(frame, syntax, grid, dec, b.child(i), qp);
        }
        return;
    }

    // Лист: режим, tx_split, затем коэффициенты Y (тайлы), Cb, Cr — зеркально сериализации.
    let mode = syntax.decode_mode(dec, grid.dir_ctx(b.x, b.y));
    let tx_split = syntax.decode_tx_split(dec, b.n);
    grid.fill(b.x, b.y, b.n, mode);

    let tsize = luma_tile_size(b.n, tx_split);
    let per_row = b.n / tsize;
    let t2 = tsize * tsize;
    let mut luma = Vec::with_capacity(per_row * per_row);
    let mut buf = vec![0i32; t2];
    for _ in 0..per_row * per_row {
        syntax.coeffs.decode_block(dec, 0, tsize, &mut buf);
        luma.push(buf.clone());
    }
    let bc = b.chroma();
    let mut cb = vec![0i32; bc.n * bc.n];
    let mut cr = vec![0i32; bc.n * bc.n];
    syntax.coeffs.decode_block(dec, 1, bc.n, &mut cb);
    syntax.coeffs.decode_block(dec, 1, bc.n, &mut cr);

    reconstruct_plane_block(&mut frame.y, b, LUMA_GRID, tsize, mode, &luma, qp);
    reconstruct_plane_block(
        &mut frame.cb,
        bc,
        CHROMA_GRID,
        bc.n,
        mode,
        std::slice::from_ref(&cb),
        qp,
    );
    reconstruct_plane_block(
        &mut frame.cr,
        bc,
        CHROMA_GRID,
        bc.n,
        mode,
        std::slice::from_ref(&cr),
        qp,
    );
}
