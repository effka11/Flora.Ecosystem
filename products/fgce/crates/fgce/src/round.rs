//! Rounded boxes (`fgce.md` §8.5).
//!
//! Straight parts of a rounded box are painted as dense spans; only the four
//! `r × r` corners need coverage. Corner coverage is the exact area of the circle
//! quarter inside a pixel, so the edge antialiases like `vector` fills do.
//! Corner masks are cached per radius: every avatar of one size reuses one mask.

use std::collections::HashMap;

use crate::contract::{Blend, Color, Edge, Error, Radius, Rect, Verb};
use crate::span;
use crate::{fill, spx};

/// Largest cached corner mask side in sPx. Bigger radii are evaluated per pixel.
const MAX_CACHED_RADIUS: i32 = 128;
/// Cache budget; the whole map is dropped when the next mask does not fit.
const MAX_CACHE_BYTES: usize = 1 << 20;

/// Coverage masks of corner quarters, keyed by radius.
#[derive(Default)]
pub(crate) struct CornerCache {
    masks: HashMap<u32, Vec<u16>>,
    bytes: usize,
}

impl CornerCache {
    fn mask(&mut self, radius: i32) -> &[u16] {
        let key = radius as u32;
        if !self.masks.contains_key(&key) {
            let side = radius as usize;
            let size = side * side;
            if self.bytes + size * 2 > MAX_CACHE_BYTES {
                self.masks.clear();
                self.bytes = 0;
            }
            let mut mask = vec![0_u16; size];
            for j in 0..radius {
                for i in 0..radius {
                    mask[(j * radius + i) as usize] = corner_coverage(i, j, radius);
                }
            }
            self.bytes += size * 2;
            self.masks.insert(key, mask);
        }
        &self.masks[&key]
    }
}

/// Resolves a radius against the painted box: the value is clamped to half of
/// the smaller side, so `Percent(50)` is a circle on a square and a capsule on
/// a rectangle (`fgce.md` §8.5).
pub(crate) fn resolve(radius: Radius, rect: Rect, k: u32) -> Result<i32, Error> {
    let min_side = rect.width().min(rect.height());
    if min_side <= 0 {
        return Ok(0);
    }
    let value = match radius {
        Radius::Percent(percent) => {
            if percent > 50 {
                return Err(Error::BadRadius);
            }
            (min_side * percent as i64 + 50) / 100
        }
        Radius::Edge(edge) => {
            let value = match edge {
                Edge::Grid { .. } => spx::parse_edge(edge, true, k)?,
                Edge::Pixel(_) => spx::parse_edge(edge, false, k)?,
            };
            if value < 0 {
                return Err(Error::BadRadius);
            }
            value as i64
        }
    };
    Ok(value.min(min_side / 2) as i32)
}

/// Paints the rounded `rect` inside `view` (already intersected with the clip).
/// `radius` is a resolved sPx value; the shape is clamped to the box again so a
/// stale radius can never spill outside.
#[allow(clippy::too_many_arguments)]
pub(crate) fn fill(
    bytes: &mut [u8],
    stride: usize,
    view: Rect,
    rect: Rect,
    radius: i32,
    color: Color,
    blend: Blend,
    corners: &mut CornerCache,
) {
    let clipped = view.intersect(rect);
    if clipped.is_empty() {
        return;
    }
    let half = (rect.width().min(rect.height()) / 2) as i32;
    let radius = radius.clamp(0, half);
    // `DstOut` keeps the shape and clears everything outside it, so the shape
    // coverage turns into `1 - coverage`. A radius of 0 has nothing outside.
    let mask = blend == Blend::DstOut;
    if radius == 0 {
        if !mask {
            fill::fill_rect(bytes, stride, clipped, color, blend);
        }
        return;
    }

    let cached = radius <= MAX_CACHED_RADIUS;
    let corner_mask = if cached {
        Some(corners.mask(radius))
    } else {
        None
    };

    let left_last = rect.x1 + radius - 1;
    let right_first = rect.x2 - radius + 1;
    let top_last = rect.y1 + radius - 1;
    let bottom_first = rect.y2 - radius + 1;

    for y in clipped.y1..=clipped.y2 {
        let start = y as usize * stride;
        let row = &mut bytes[start..start + stride];
        let depth = if y <= top_last {
            Some(y - rect.y1)
        } else if y >= bottom_first {
            Some(rect.y2 - y)
        } else {
            None
        };
        let Some(depth) = depth else {
            if !mask {
                span::paint(row, clipped.x1, clipped.x2, color, span::FULL_COVER, blend);
            }
            continue;
        };

        let middle_from = left_last + 1;
        let middle_to = right_first - 1;
        if !mask && middle_from <= middle_to {
            let from = clipped.x1.max(middle_from);
            let to = clipped.x2.min(middle_to);
            if from <= to {
                span::paint(row, from, to, color, span::FULL_COVER, blend);
            }
        }

        if clipped.x1 <= left_last {
            let from = clipped.x1;
            let to = clipped.x2.min(left_last);
            for x in from..=to {
                let coverage = corner_coverage_at(corner_mask, radius, x - rect.x1, depth);
                span::paint(row, x, x, color, invert(coverage, mask), blend);
            }
        }
        if clipped.x2 >= right_first {
            let from = clipped.x1.max(right_first);
            let to = clipped.x2;
            for x in from..=to {
                let coverage = corner_coverage_at(corner_mask, radius, rect.x2 - x, depth);
                span::paint(row, x, x, color, invert(coverage, mask), blend);
            }
        }
    }
}

fn corner_coverage_at(mask: Option<&[u16]>, radius: i32, i: i32, j: i32) -> u16 {
    match mask {
        Some(mask) => mask[(j * radius + i) as usize],
        None => corner_coverage(i, j, radius),
    }
}

fn invert(coverage: u16, mask: bool) -> u16 {
    if mask {
        span::FULL_COVER - coverage
    } else {
        coverage
    }
}

/// Path of the rounded box outline, in sPx edges. `radius` is resolved.
pub(crate) fn path(rect: Rect, radius: i32, out: &mut Vec<Verb>) {
    out.clear();
    let half = (rect.width().min(rect.height()) / 2) as i32;
    let radius = radius.clamp(0, half);
    let (x1, y1) = (rect.x1, rect.y1);
    let (x2, y2) = (rect.x2 + 1, rect.y2 + 1);
    if radius == 0 {
        out.push(Verb::Move(x1, y1));
        out.push(Verb::Line(x2, y1));
        out.push(Verb::Line(x2, y2));
        out.push(Verb::Line(x1, y2));
        out.push(Verb::Close);
        return;
    }
    // Circle-to-cubic constant: a quarter arc is exact enough at sub-pixel scale.
    let k = (0.552_284_749_830_793_6 * radius as f64).round() as i32;
    out.push(Verb::Move(x1 + radius, y1));
    out.push(Verb::Line(x2 - radius, y1));
    out.push(Verb::Cubic(
        x2 - radius + k,
        y1,
        x2,
        y1 + radius - k,
        x2,
        y1 + radius,
    ));
    out.push(Verb::Line(x2, y2 - radius));
    out.push(Verb::Cubic(
        x2,
        y2 - radius + k,
        x2 - radius + k,
        y2,
        x2 - radius,
        y2,
    ));
    out.push(Verb::Line(x1 + radius, y2));
    out.push(Verb::Cubic(
        x1 + radius - k,
        y2,
        x1,
        y2 - radius + k,
        x1,
        y2 - radius,
    ));
    out.push(Verb::Line(x1, y1 + radius));
    out.push(Verb::Cubic(
        x1,
        y1 + radius - k,
        x1 + radius - k,
        y1,
        x1 + radius,
        y1,
    ));
    out.push(Verb::Close);
}

/// Coverage of the corner pixel `(i, j)`, counted from the box corner towards
/// the arc centre `(radius, radius)`.
fn corner_coverage(i: i32, j: i32, radius: i32) -> u16 {
    let r = radius as f64;
    let x0 = (radius - i - 1) as f64;
    let x1 = (radius - i) as f64;
    let y0 = (radius - j - 1) as f64;
    let y1 = (radius - j) as f64;
    let area = corner_area(x1, y1, r) - corner_area(x0, y1, r) - corner_area(x1, y0, r)
        + corner_area(x0, y0, r);
    cover_from_area(area)
}

fn cover_from_area(area: f64) -> u16 {
    let cover = (area * 256.0 + 0.5).floor();
    cover.clamp(0.0, 256.0) as u16
}

/// Area of the quarter disc `x² + y² <= r²` inside `[0, x] × [0, y]`.
fn corner_area(x: f64, y: f64, r: f64) -> f64 {
    if x <= 0.0 || y <= 0.0 {
        return 0.0;
    }
    let x = x.min(r);
    let y = y.min(r);
    if x * x + y * y <= r * r {
        return x * y;
    }
    // Up to `t0` the disc is taller than `y`; after it the arc bounds the area.
    let t0 = (r * r - y * y).max(0.0).sqrt();
    if x <= t0 {
        return x * y;
    }
    t0 * y + arc_area(x, r) - arc_area(t0, r)
}

/// Antiderivative of `sqrt(r² - t²)`.
fn arc_area(t: f64, r: f64) -> f64 {
    let t = t.clamp(-r, r);
    0.5 * (t * (r * r - t * t).max(0.0).sqrt() + r * r * (t / r).asin())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_rect(x1: i32, y1: i32, x2: i32, y2: i32) -> Rect {
        Rect { x1, y1, x2, y2 }
    }

    fn coverage(bytes: &[u8], stride: usize, x: i32, y: i32) -> u8 {
        bytes[y as usize * stride + x as usize * 4 + 3]
    }

    const WHITE: Color = Color {
        r: 255,
        g: 255,
        b: 255,
        a: 255,
    };

    #[test]
    fn percent_fifty_is_a_circle_on_a_square() {
        let rect = box_rect(0, 0, 44, 44);
        assert_eq!(resolve(Radius::Percent(50), rect, 5), Ok(22));
        assert_eq!(
            resolve(Radius::Percent(100), rect, 5),
            Err(Error::BadRadius)
        );
        assert_eq!(
            resolve(
                Radius::Edge(Edge::Grid {
                    primary: 1,
                    fine: None,
                    spx: None
                }),
                rect,
                5
            ),
            Ok(15)
        );
        assert_eq!(
            resolve(Radius::Edge(Edge::Pixel(30)), rect, 5),
            Ok(22),
            "a radius never exceeds half of the smaller side"
        );
    }

    #[test]
    fn percent_resolves_from_the_smaller_side() {
        let rect = box_rect(0, 0, 99, 19);
        assert_eq!(resolve(Radius::Percent(50), rect, 5), Ok(10));
        assert_eq!(resolve(Radius::Percent(25), rect, 5), Ok(5));
    }

    #[test]
    fn a_rounded_fill_keeps_the_corner_pixel_empty() {
        let stride = 32;
        let mut bytes = vec![0_u8; stride * 8];
        let mut corners = CornerCache::default();
        fill(
            &mut bytes,
            stride,
            box_rect(0, 0, 7, 7),
            box_rect(0, 0, 7, 7),
            4,
            WHITE,
            Blend::SrcOver,
            &mut corners,
        );
        assert_eq!(
            coverage(&bytes, stride, 0, 0),
            0,
            "corner pixel stays clear"
        );
        assert_eq!(coverage(&bytes, stride, 4, 4), 255, "inner pixel is opaque");
        assert_eq!(coverage(&bytes, stride, 7, 0), 0);
        assert_eq!(coverage(&bytes, stride, 0, 7), 0);
        assert_eq!(coverage(&bytes, stride, 7, 7), 0);
    }

    #[test]
    fn dst_out_clears_the_corners_and_keeps_the_middle() {
        let stride = 32;
        let mut bytes = vec![255_u8; stride * 8];
        let mut corners = CornerCache::default();
        fill(
            &mut bytes,
            stride,
            box_rect(0, 0, 7, 7),
            box_rect(0, 0, 7, 7),
            4,
            WHITE,
            Blend::DstOut,
            &mut corners,
        );
        assert_eq!(coverage(&bytes, stride, 0, 0), 0);
        assert_eq!(coverage(&bytes, stride, 4, 4), 255);
        assert_eq!(&bytes[0..4], &[0, 0, 0, 0], "dst_out zeroes every channel");
    }

    #[test]
    fn zero_radius_is_the_plain_rectangle() {
        let stride = 16;
        let mut bytes = vec![0_u8; stride * 8];
        let mut corners = CornerCache::default();
        fill(
            &mut bytes,
            stride,
            box_rect(0, 0, 3, 3),
            box_rect(0, 0, 3, 3),
            0,
            WHITE,
            Blend::SrcOver,
            &mut corners,
        );
        assert_eq!(coverage(&bytes, stride, 0, 0), 255);
        assert_eq!(coverage(&bytes, stride, 3, 3), 255);
    }

    #[test]
    fn the_view_clips_the_rounded_shape() {
        let stride = 32;
        let mut bytes = vec![0_u8; stride * 8];
        let mut corners = CornerCache::default();
        fill(
            &mut bytes,
            stride,
            box_rect(4, 4, 7, 7),
            box_rect(0, 0, 7, 7),
            4,
            WHITE,
            Blend::SrcOver,
            &mut corners,
        );
        assert_eq!(coverage(&bytes, stride, 3, 3), 0);
        assert_eq!(coverage(&bytes, stride, 4, 4), 255);
        assert_eq!(coverage(&bytes, stride, 7, 7), 0);
    }

    #[test]
    fn corner_area_matches_a_quarter_disc() {
        let quarter = std::f64::consts::FRAC_PI_4;
        assert!((corner_area(4.0, 4.0, 4.0) - 16.0 * quarter).abs() < 1e-9);
        assert_eq!(corner_area(1.0, 1.0, 4.0), 1.0, "inside the disc");
        assert_eq!(corner_area(0.0, 3.0, 4.0), 0.0);
    }

    #[test]
    fn the_outline_is_a_closed_rounded_path() {
        let mut verbs = Vec::new();
        path(box_rect(0, 0, 9, 9), 3, &mut verbs);
        assert!(matches!(verbs.first(), Some(Verb::Move(3, 0))));
        assert!(matches!(verbs.last(), Some(Verb::Close)));
        assert_eq!(
            verbs
                .iter()
                .filter(|verb| matches!(verb, Verb::Cubic(..)))
                .count(),
            4
        );

        path(box_rect(0, 0, 9, 9), 0, &mut verbs);
        assert_eq!(verbs.len(), 5);
        assert!(matches!(verbs.first(), Some(Verb::Move(0, 0))));
    }
}
