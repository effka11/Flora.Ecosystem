//! The only writer of frame bytes (`fgce.md` §2.3, §7, §11.9).
//!
//! Every row write goes through this module: dense opaque copy, per-pixel over,
//! source replacement and clear. No locks, channels or allocations here.
//! `frame` owns the buffer; this module receives one row at a time.

use crate::color::{self, Premul};
use crate::contract::{Blend, Color};

pub(crate) const FULL_COVER: u16 = 256;

/// Clears the whole frame; `span` stays the only writer of frame bytes.
pub(crate) fn clear(bytes: &mut [u8]) {
    bytes.fill(0);
}

fn cover_alpha(coverage: u16) -> u8 {
    if coverage >= FULL_COVER {
        255
    } else {
        ((coverage as u32 * 255 + 128) / 256) as u8
    }
}

/// Paints a straight color into one row with pixel coverage `0..=256` (`fgce.md` §8.3).
pub(crate) fn paint(row: &mut [u8], x1: i32, x2: i32, color: Color, coverage: u16, blend: Blend) {
    if coverage == 0 {
        return;
    }
    let src = if coverage >= FULL_COVER {
        Premul::from_color(color)
    } else {
        let a = (cover_alpha(coverage) as u32 * color.a as u32 + 127) / 255;
        Premul {
            r: color::pm(color.r, a as u8),
            g: color::pm(color.g, a as u8),
            b: color::pm(color.b, a as u8),
            a: a as u8,
        }
    };
    write_row(row, x1, x2, src, blend, coverage);
}

/// Paints an already premultiplied texel into one row at full coverage.
pub(crate) fn paint_premul(row: &mut [u8], x1: i32, x2: i32, src: Premul, blend: Blend) {
    write_row(row, x1, x2, src, blend, FULL_COVER);
}

/// Copies a premultiplied span into one row; the caller guarantees the ranges.
pub(crate) fn copy_row_premul(row: &mut [u8], x1: i32, x2: i32, pixels: &[u8]) {
    if x2 < x1 {
        return;
    }
    debug_assert_eq!(pixels.len(), (x2 - x1 + 1) as usize * 4);
    let start = x1 as usize * 4;
    row[start..start + pixels.len()].copy_from_slice(pixels);
}

/// Converts one premultiplied row to straight alpha (`ReadPixels`).
pub(crate) fn straight_row(src: &[u8], out: &mut Vec<u8>) {
    for pixel in src.chunks_exact(4) {
        let a = pixel[3];
        out.push(color::straight(pixel[0], a));
        out.push(color::straight(pixel[1], a));
        out.push(color::straight(pixel[2], a));
        out.push(a);
    }
}

fn write_row(row: &mut [u8], x1: i32, x2: i32, src: Premul, blend: Blend, coverage: u16) {
    if x2 < x1 {
        return;
    }
    let start = x1 as usize * 4;
    let end = (x2 as usize + 1) * 4;
    let dst = &mut row[start..end];
    match blend {
        Blend::Clear => {
            if coverage >= FULL_COVER {
                dst.fill(0);
            }
        }
        Blend::DstOut => {
            let keep = 255 - cover_alpha(coverage);
            if keep == 0 {
                dst.fill(0);
            } else if keep < 255 {
                for pixel in dst.chunks_exact_mut(4) {
                    for channel in pixel.iter_mut() {
                        *channel = ((*channel as u32 * keep as u32 + 127) / 255) as u8;
                    }
                }
            }
        }
        Blend::Src => write_solid(dst, src),
        Blend::SrcOver => {
            // Alpha 0 never reads or writes the destination; alpha 255 is a dense write.
            if src.a == 0 {
                return;
            }
            if src.a == 255 {
                write_solid(dst, src);
            } else {
                write_over(dst, src);
            }
        }
    }
}

fn write_solid(dst: &mut [u8], src: Premul) {
    let pixel = [src.r, src.g, src.b, src.a];
    let mut chunk = [0_u8; 16];
    for part in chunk.chunks_exact_mut(4) {
        part.copy_from_slice(&pixel);
    }
    let mut blocks = dst.chunks_exact_mut(16);
    for block in &mut blocks {
        block.copy_from_slice(&chunk);
    }
    for part in blocks.into_remainder().chunks_exact_mut(4) {
        part.copy_from_slice(&pixel);
    }
}

fn write_over(dst: &mut [u8], src: Premul) {
    for pixel in dst.chunks_exact_mut(4) {
        let dst_pixel = Premul {
            r: pixel[0],
            g: pixel[1],
            b: pixel[2],
            a: pixel[3],
        };
        let mixed = src.over(dst_pixel);
        pixel.copy_from_slice(&[mixed.r, mixed.g, mixed.b, mixed.a]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::Rect;

    const STRIDE: usize = 64;

    fn buffer() -> Vec<u8> {
        vec![0_u8; STRIDE]
    }

    fn pixel(bytes: &[u8], x: usize) -> [u8; 4] {
        bytes[x * 4..x * 4 + 4].try_into().unwrap()
    }

    #[test]
    fn opaque_write_is_dense() {
        let mut bytes = buffer();
        paint(
            &mut bytes,
            1,
            2,
            Color {
                r: 10,
                g: 20,
                b: 30,
                a: 255,
            },
            FULL_COVER,
            Blend::SrcOver,
        );
        assert_eq!(pixel(&bytes, 0), [0, 0, 0, 0]);
        assert_eq!(pixel(&bytes, 1), [10, 20, 30, 255]);
        assert_eq!(pixel(&bytes, 2), [10, 20, 30, 255]);
    }

    #[test]
    fn full_cover_with_half_alpha_stays_half() {
        let mut bytes = buffer();
        paint(
            &mut bytes,
            0,
            0,
            Color {
                r: 255,
                g: 0,
                b: 0,
                a: 128,
            },
            FULL_COVER,
            Blend::SrcOver,
        );
        assert_eq!(
            pixel(&bytes, 0),
            [128, 0, 0, 128],
            "coverage 256 and color.a = 128 give alpha 128"
        );
    }

    #[test]
    fn transparent_source_does_not_read_destination() {
        let mut bytes = buffer();
        paint(
            &mut bytes,
            0,
            3,
            Color {
                r: 200,
                g: 200,
                b: 200,
                a: 255,
            },
            FULL_COVER,
            Blend::SrcOver,
        );
        paint(
            &mut bytes,
            0,
            3,
            Color {
                r: 1,
                g: 2,
                b: 3,
                a: 0,
            },
            FULL_COVER,
            Blend::SrcOver,
        );
        assert_eq!(pixel(&bytes, 0), [200, 200, 200, 255]);
    }

    #[test]
    fn partial_coverage_clear_is_noop() {
        let mut bytes = buffer();
        paint(
            &mut bytes,
            0,
            0,
            Color {
                r: 9,
                g: 9,
                b: 9,
                a: 255,
            },
            FULL_COVER,
            Blend::SrcOver,
        );
        paint(
            &mut bytes,
            0,
            0,
            Color {
                r: 0,
                g: 0,
                b: 0,
                a: 255,
            },
            128,
            Blend::Clear,
        );
        assert_eq!(pixel(&bytes, 0), [9, 9, 9, 255]);
        paint(
            &mut bytes,
            0,
            0,
            Color {
                r: 0,
                g: 0,
                b: 0,
                a: 255,
            },
            FULL_COVER,
            Blend::Clear,
        );
        assert_eq!(pixel(&bytes, 0), [0, 0, 0, 0]);
    }

    #[test]
    fn dst_out_scales_destination_by_coverage() {
        let mut bytes = buffer();
        paint(
            &mut bytes,
            0,
            0,
            Color {
                r: 200,
                g: 100,
                b: 50,
                a: 200,
            },
            FULL_COVER,
            Blend::SrcOver,
        );
        paint(
            &mut bytes,
            0,
            0,
            Color {
                r: 0,
                g: 0,
                b: 0,
                a: 255,
            },
            128,
            Blend::DstOut,
        );
        assert_eq!(pixel(&bytes, 0), [78, 39, 19, 100]);
        paint(
            &mut bytes,
            0,
            0,
            Color {
                r: 0,
                g: 0,
                b: 0,
                a: 255,
            },
            FULL_COVER,
            Blend::DstOut,
        );
        assert_eq!(pixel(&bytes, 0), [0, 0, 0, 0]);
    }

    #[test]
    fn src_writes_even_when_transparent() {
        let mut bytes = buffer();
        paint(
            &mut bytes,
            0,
            0,
            Color {
                r: 9,
                g: 9,
                b: 9,
                a: 255,
            },
            FULL_COVER,
            Blend::SrcOver,
        );
        paint(
            &mut bytes,
            0,
            0,
            Color {
                r: 0,
                g: 0,
                b: 0,
                a: 0,
            },
            FULL_COVER,
            Blend::Src,
        );
        assert_eq!(pixel(&bytes, 0), [0, 0, 0, 0]);
    }

    #[test]
    fn fill_rect_helper_covers_whole_row() {
        let mut bytes = buffer();
        crate::fill::fill_rect(
            &mut bytes,
            STRIDE,
            Rect {
                x1: 0,
                y1: 0,
                x2: 3,
                y2: 0,
            },
            Color {
                r: 1,
                g: 2,
                b: 3,
                a: 255,
            },
            Blend::SrcOver,
        );
        for x in 0..4 {
            assert_eq!(pixel(&bytes, x), [1, 2, 3, 255]);
        }
    }

    #[test]
    fn straight_row_converts_premultiplied_bytes() {
        let mut out = Vec::new();
        straight_row(&[100, 50, 25, 128], &mut out);
        assert_eq!(out, [199, 100, 50, 128]);
    }
}
