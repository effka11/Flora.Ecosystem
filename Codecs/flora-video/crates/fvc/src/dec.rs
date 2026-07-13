//! Декодер FVC1.
//!
//! Никогда не паникует на произвольном входе: структурные ошибки → `Err`,
//! осмысленно-повреждённый арифметический поток → мусорное, но безопасное изображение
//! (все пути реконструкции клампированы, счётчики синтаксиса конечны).
//!
//! Состояние между кадрами — один опорный кадр (последний декодированный).
//! P-кадр без опоры (начало потока не с ключевого) использует серую опору 128 —
//! детерминированное, безопасное поведение для стриминга.

use crate::block::{LeafData, LeafGrid, LeafKind, luma_tile_size, reconstruct_leaf};
use crate::ec::BoolDecoder;
use crate::frame::Frame;
use crate::header::FrameHeader;
use crate::lf::loop_filter;
use crate::mc::RefFrame;
use crate::syntax::SyntaxModel;
use crate::{Blk, Error, NodePlacement, SB_SIZE, place_node};

#[derive(Default)]
pub struct Decoder {
    reference: Option<RefFrame>,
}

impl Decoder {
    pub fn new() -> Self {
        Decoder { reference: None }
    }

    pub fn decode_frame(&mut self, data: &[u8]) -> Result<Frame, Error> {
        let (header, payload) = FrameHeader::parse(data)?;
        let (w, h) = (header.width as usize, header.height as usize);

        if !header.keyframe {
            // Опора обязана совпадать по размерам; отсутствующая → серая (128).
            match &self.reference {
                Some(r) if r.frame.width() == w && r.frame.height() == h => {}
                Some(_) => return Err(Error::InvalidBitstream("dimension change on inter frame")),
                None => self.reference = Some(RefFrame::new(Frame::new(w, h))),
            }
        }

        let mut frame = Frame::new(w, h);
        let mut syntax = SyntaxModel::default();
        let mut grid = LeafGrid::new(w, h);
        let mut dec = BoolDecoder::new(payload);

        for sb_y in (0..h).step_by(SB_SIZE) {
            for sb_x in (0..w).step_by(SB_SIZE) {
                let sb = Blk { x: sb_x, y: sb_y, n: SB_SIZE };
                self.parse_node(&mut frame, &mut syntax, &mut grid, &mut dec, sb, &header);
            }
        }
        if header.loop_filter {
            loop_filter(&mut frame, header.qp);
        }
        self.reference = Some(RefFrame::new(frame.clone()));
        Ok(frame)
    }

    fn parse_node(
        &self,
        frame: &mut Frame,
        syntax: &mut SyntaxModel,
        grid: &mut LeafGrid,
        dec: &mut BoolDecoder<'_>,
        b: Blk,
        header: &FrameHeader,
    ) {
        let split = match place_node(b, frame.width(), frame.height()) {
            NodePlacement::Outside => return,
            NodePlacement::MustSplit => true,
            NodePlacement::Leaf => false,
            NodePlacement::Choice => syntax.decode_split(dec, b.n),
        };
        if split {
            for i in 0..4 {
                self.parse_node(frame, syntax, grid, dec, b.child(i), header);
            }
            return;
        }
        let leaf = parse_leaf(syntax, grid, dec, b, header.keyframe);
        grid.fill_leaf(b, &leaf.kind);
        reconstruct_leaf(frame, self.reference.as_ref(), b, &leaf, header.qp);
    }
}

/// Разбор синтаксиса листа (зеркально `Encoder::serialize_node`).
fn parse_leaf(
    syntax: &mut SyntaxModel,
    grid: &LeafGrid,
    dec: &mut BoolDecoder<'_>,
    b: Blk,
    keyframe: bool,
) -> LeafData {
    let is_inter = !keyframe && syntax.decode_is_inter(dec, grid.inter_ctx(b.x, b.y));

    if is_inter {
        let mvd = syntax.decode_mvd(dec);
        let mv = grid.resolve_mv(b.x, b.y, b.n, mvd);
        let skip = syntax.decode_skip(dec);
        if skip {
            return LeafData {
                kind: LeafKind::Inter { mv, skip: true },
                tx_split: false,
                luma: Vec::new(),
                cb: Vec::new(),
                cr: Vec::new(),
            };
        }
        let (tx_split, luma, cb, cr) = parse_coeffs(syntax, dec, b);
        LeafData { kind: LeafKind::Inter { mv, skip: false }, tx_split, luma, cb, cr }
    } else {
        let mode = syntax.decode_mode(dec, grid.dir_ctx(b.x, b.y));
        let chroma_mode = syntax.decode_chroma_mode(dec);
        let (tx_split, luma, cb, cr) = parse_coeffs(syntax, dec, b);
        LeafData { kind: LeafKind::Intra { mode, chroma_mode }, tx_split, luma, cb, cr }
    }
}

/// tx_split + коэффициенты Y (тайлы), Cb, Cr.
fn parse_coeffs(
    syntax: &mut SyntaxModel,
    dec: &mut BoolDecoder<'_>,
    b: Blk,
) -> (bool, Vec<Vec<i32>>, Vec<i32>, Vec<i32>) {
    let tx_split = syntax.decode_tx_split(dec, b.n);
    let tsize = luma_tile_size(b.n, tx_split);
    let per_row = b.n / tsize;
    let t2 = tsize * tsize;
    let mut luma = Vec::with_capacity(per_row * per_row);
    let mut buf = vec![0i32; t2];
    for _ in 0..per_row * per_row {
        syntax.coeffs.decode_block(dec, 0, tsize, &mut buf);
        luma.push(buf.clone());
    }
    let cn = b.n / 2;
    let mut cb = vec![0i32; cn * cn];
    let mut cr = vec![0i32; cn * cn];
    syntax.coeffs.decode_block(dec, 1, cn, &mut cb);
    syntax.coeffs.decode_block(dec, 1, cn, &mut cr);
    (tx_split, luma, cb, cr)
}
