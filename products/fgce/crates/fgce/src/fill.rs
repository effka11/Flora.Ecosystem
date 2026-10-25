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
