//! Solid rectangle into spans (`fgce.md` §8.1).
//!
//! Receives the frame bytes and stride; `frame` owns the buffer.

use crate::contract::{Blend, Color, Rect};
use crate::span;

/// The rectangle is expected to be already intersected with clip and frame.
pub(crate) fn fill_rect(bytes: &mut [u8], stride: usize, rect: Rect, color: Color, blend: Blend) {
    if rect.is_empty() {
        return;
    }
    for y in rect.y1..=rect.y2 {
        let start = y as usize * stride;
        let row = &mut bytes[start..start + stride];
        span::paint(row, rect.x1, rect.x2, color, span::FULL_COVER, blend);
    }
}

#[derive(Clone, Copy)]
pub(crate) struct LatticeLines {
    pub(crate) rect: Rect,
    pub(crate) step: u32,
    pub(crate) primary_step: Option<u32>,
}

/// One-sPx lattice lines (`fgce.md` §5.3). Vertical lines are painted first,
/// then horizontal, so a crossing takes the horizontal color. The clip is
/// applied to every line independently.
pub(crate) fn fill_lattice(
    bytes: &mut [u8],
    stride: usize,
    clip: Rect,
    lines: &LatticeLines,
    fine_color: Color,
    primary_color: Color,
    blend: Blend,
) {
    let rect = lines.rect;
    if rect.is_empty() || lines.step == 0 {
        return;
    }
    let step = lines.step as i64;
    let primary = |offset: i64| match lines.primary_step {
        Some(primary_step) => offset % primary_step as i64 == 0,
        None => false,
    };
    let mut x = rect.x1 as i64;
    while x <= rect.x2 as i64 {
        let offset = x - rect.x1 as i64;
        let color = if primary(offset) {
            primary_color
        } else {
            fine_color
        };
        let line = Rect {
            x1: x as i32,
            y1: rect.y1,
            x2: x as i32,
            y2: rect.y2,
        }
        .intersect(clip);
        fill_rect(bytes, stride, line, color, blend);
        x += step;
    }
    let mut y = rect.y1 as i64;
    while y <= rect.y2 as i64 {
        let offset = y - rect.y1 as i64;
        let color = if primary(offset) {
            primary_color
        } else {
            fine_color
        };
        let line = Rect {
            x1: rect.x1,
            y1: y as i32,
            x2: rect.x2,
            y2: y as i32,
        }
        .intersect(clip);
        fill_rect(bytes, stride, line, color, blend);
        y += step;
    }
}
