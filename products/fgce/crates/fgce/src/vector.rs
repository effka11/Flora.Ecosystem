//! Vector paths: parsing, curve flattening, exact fill coverage, stroke outline
//! and `Measure` (`fgce.md` §8.3, §8.4).

use crate::contract::{Blend, Cap, Color, Error, FillRule, Join, Rect, Stroke, StrokeAlign, Verb};
use crate::{MAX_COORD, MAX_VERTICES, span};

const MAX_DEPTH: u32 = 64;
const AREA_EPS: f64 = 1e-12;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct PointQ8 {
    x: i32,
    y: i32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct PointQ16 {
    x: i64,
    y: i64,
}

#[derive(Clone, Copy, Debug)]
struct EdgeQ8 {
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
}

#[derive(Clone, Debug)]
struct Contour {
    points: Vec<PointQ8>,
    /// `true` when the source path closed this contour with `Close`; the stroke
    /// branch depends on it (`fgce.md` §8.4), the fill branch does not.
    closed: bool,
}

#[derive(Clone, Debug)]
struct Path {
    contours: Vec<Contour>,
}

impl Path {
    fn parse(verbs: &[Verb]) -> Result<Self, Error> {
        if verbs.is_empty() {
            return Err(Error::BadPath);
        }
        let mut contours: Vec<Contour> = Vec::new();
        let mut current: Option<usize> = None;
        let mut current_q16 = PointQ16 { x: 0, y: 0 };
        let mut vertices = 0_usize;

        for verb in verbs {
            match *verb {
                Verb::Move(x, y) => {
                    check_point(x, y)?;
                    vertices += 1;
                    check_vertices(vertices)?;
                    contours.push(Contour {
                        points: vec![point_q8(x, y)],
                        closed: false,
                    });
                    current = Some(contours.len() - 1);
                    current_q16 = point_q16(x, y);
                }
                Verb::Line(x, y) => {
                    let index = current.ok_or(Error::BadPath)?;
                    check_point(x, y)?;
                    vertices += 1;
                    check_vertices(vertices)?;
                    push_q8(&mut contours[index].points, point_q16(x, y));
                    current_q16 = point_q16(x, y);
                }
                Verb::Quad(cx, cy, x, y) => {
                    let index = current.ok_or(Error::BadPath)?;
                    check_point(cx, cy)?;
                    check_point(x, y)?;
                    vertices += 2;
                    check_vertices(vertices)?;
                    let mut points = Vec::new();
                    flatten_quad(
                        current_q16,
                        point_q16(cx, cy),
                        point_q16(x, y),
                        &mut points,
                        0,
                    );
                    for point in points {
                        push_q8(&mut contours[index].points, point);
                    }
                    current_q16 = point_q16(x, y);
                }
                Verb::Cubic(c0x, c0y, c1x, c1y, x, y) => {
                    let index = current.ok_or(Error::BadPath)?;
                    check_point(c0x, c0y)?;
                    check_point(c1x, c1y)?;
                    check_point(x, y)?;
                    vertices += 3;
                    check_vertices(vertices)?;
                    let mut points = Vec::new();
                    flatten_cubic(
                        current_q16,
                        point_q16(c0x, c0y),
                        point_q16(c1x, c1y),
                        point_q16(x, y),
                        &mut points,
                        0,
                    );
                    for point in points {
                        push_q8(&mut contours[index].points, point);
                    }
                    current_q16 = point_q16(x, y);
                }
                Verb::Close => {
                    let index = current.ok_or(Error::BadPath)?;
                    let start = contours[index].points[0];
                    if contours[index].points.last() != Some(&start) {
                        contours[index].points.push(start);
                    }
                    contours[index].closed = true;
                    current = None;
                }
            }
        }

        Ok(Path { contours })
    }

    fn bounds(&self) -> Option<(i32, i32, i32, i32)> {
        let mut min_x = i32::MAX;
        let mut min_y = i32::MAX;
        let mut max_x = i32::MIN;
        let mut max_y = i32::MIN;
        let mut found = false;
        for contour in &self.contours {
            for point in &contour.points {
                found = true;
                min_x = min_x.min(point.x);
                min_y = min_y.min(point.y);
                max_x = max_x.max(point.x);
                max_y = max_y.max(point.y);
            }
        }
        found.then_some((min_x, min_y, max_x, max_y))
    }

    fn edges(&self, close: bool) -> Vec<EdgeQ8> {
        let mut edges = Vec::new();
        for contour in &self.contours {
            for pair in contour.points.windows(2) {
                if pair[0] != pair[1] {
                    edges.push(EdgeQ8 {
                        x0: pair[0].x,
                        y0: pair[0].y,
                        x1: pair[1].x,
                        y1: pair[1].y,
                    });
                }
            }
            if close && contour.points.len() > 1 {
                let first = contour.points[0];
                let last = *contour.points.last().expect("non-empty contour");
                if first != last {
                    edges.push(EdgeQ8 {
                        x0: last.x,
                        y0: last.y,
                        x1: first.x,
                        y1: first.y,
                    });
                }
            }
        }
        edges
    }

    fn has_area(&self) -> bool {
        for contour in &self.contours {
            let points = &contour.points;
            if points.len() < 3 {
                continue;
            }
            let origin = points[0];
            for i in 1..points.len() - 1 {
                let a = points[i];
                let b = points[i + 1];
                let ax = (a.x - origin.x) as i64;
                let ay = (a.y - origin.y) as i64;
                let bx = (b.x - origin.x) as i64;
                let by = (b.y - origin.y) as i64;
                if ax * by - ay * bx != 0 {
                    return true;
                }
            }
        }
        false
    }

    fn single_rectangle(&self) -> Option<Rect> {
        if self.contours.len() != 1 {
            return None;
        }
        let mut points = self.contours[0].points.clone();
        if points.len() > 1 && points.first() == points.last() {
            points.pop();
        }
        if points.len() != 4 {
            return None;
        }
        for point in &points {
            if point.x % 256 != 0 || point.y % 256 != 0 {
                return None;
            }
        }
        let min_x = points.iter().map(|p| p.x).min()?;
        let min_y = points.iter().map(|p| p.y).min()?;
        let max_x = points.iter().map(|p| p.x).max()?;
        let max_y = points.iter().map(|p| p.y).max()?;
        if min_x == max_x || min_y == max_y {
            return None;
        }
        let corners = [
            (min_x, min_y),
            (max_x, min_y),
            (max_x, max_y),
            (min_x, max_y),
        ];
        for &(cx, cy) in &corners {
            if points
                .iter()
                .filter(|point| point.x == cx && point.y == cy)
                .count()
                != 1
            {
                return None;
            }
        }
        for i in 0..4 {
            let a = points[i];
            let b = points[(i + 1) % 4];
            if a.x != b.x && a.y != b.y {
                return None;
            }
        }
        let rect = Rect {
            x1: min_x / 256,
            y1: min_y / 256,
            x2: max_x / 256 - 1,
            y2: max_y / 256 - 1,
        };
        (!rect.is_empty()).then_some(rect)
    }

    fn is_orthogonal(&self) -> bool {
        for contour in &self.contours {
            for point in &contour.points {
                if point.x % 256 != 0 || point.y % 256 != 0 {
                    return false;
                }
            }
            for pair in contour.points.windows(2) {
                if pair[0].x != pair[1].x && pair[0].y != pair[1].y {
                    return false;
                }
            }
            if contour.points.len() > 1 {
                let first = contour.points[0];
                let last = *contour.points.last().expect("non-empty contour");
                if first.x != last.x && first.y != last.y {
                    return false;
                }
            }
        }
        true
    }
}

fn check_vertices(count: usize) -> Result<(), Error> {
    if count > MAX_VERTICES as usize {
        Err(Error::BadPath)
    } else {
        Ok(())
    }
}

fn check_point(x: i32, y: i32) -> Result<(), Error> {
    if (x as i64).unsigned_abs() > MAX_COORD as u64 || (y as i64).unsigned_abs() > MAX_COORD as u64
    {
        Err(Error::Overflow)
    } else {
        Ok(())
    }
}

fn point_q16(x: i32, y: i32) -> PointQ16 {
    PointQ16 {
        x: (x as i64) << 16,
        y: (y as i64) << 16,
    }
}

fn point_q8(x: i32, y: i32) -> PointQ8 {
    PointQ8 {
        x: x * 256,
        y: y * 256,
    }
}

fn push_q8(points: &mut Vec<PointQ8>, point: PointQ16) {
    let point = PointQ8 {
        x: q16_to_q8(point.x),
        y: q16_to_q8(point.y),
    };
    if points.last() != Some(&point) {
        points.push(point);
    }
}

fn q16_to_q8(value: i64) -> i32 {
    let value = value as i128;
    let quotient = value / 256;
    let remainder = value % 256;
    let rounded = if remainder.abs() * 2 >= 256 {
        quotient + value.signum()
    } else {
        quotient
    };
    rounded as i32
}

fn midpoint(a: PointQ16, b: PointQ16) -> PointQ16 {
    PointQ16 {
        x: midpoint_i64(a.x, b.x),
        y: midpoint_i64(a.y, b.y),
    }
}

fn midpoint_i64(a: i64, b: i64) -> i64 {
    let sum = a as i128 + b as i128;
    let quotient = sum / 2;
    let remainder = sum % 2;
    let rounded = if remainder == 0 {
        quotient
    } else {
        quotient + sum.signum()
    };
    rounded as i64
}

fn deviation_exceeds(p0: PointQ16, control: PointQ16, p2: PointQ16) -> bool {
    let dx = (p2.x - p0.x) as i128;
    let dy = (p2.y - p0.y) as i128;
    let vx = (control.x - p0.x) as i128;
    let vy = (control.y - p0.y) as i128;
    let cross = dx * vy - dy * vx;
    let chord = dx * dx + dy * dy;
    let lhs = cross.unsigned_abs();
    let rhs = (chord as u128) << 28;
    if lhs > (1_u128 << 63) {
        true
    } else {
        lhs * lhs > rhs
    }
}

fn flatten_quad(p0: PointQ16, p1: PointQ16, p2: PointQ16, out: &mut Vec<PointQ16>, depth: u32) {
    if depth >= MAX_DEPTH || !deviation_exceeds(p0, p1, p2) {
        out.push(p2);
        return;
    }
    let (m01, m12, split) = split_quad(p0, p1, p2);
    flatten_quad(p0, m01, split, out, depth + 1);
    flatten_quad(split, m12, p2, out, depth + 1);
}

fn split_quad(p0: PointQ16, p1: PointQ16, p2: PointQ16) -> (PointQ16, PointQ16, PointQ16) {
    let m01 = midpoint(p0, p1);
    let m12 = midpoint(p1, p2);
    let split = midpoint(m01, m12);
    (m01, m12, split)
}

fn flatten_cubic(
    p0: PointQ16,
    p1: PointQ16,
    p2: PointQ16,
    p3: PointQ16,
    out: &mut Vec<PointQ16>,
    depth: u32,
) {
    if depth >= MAX_DEPTH || (!deviation_exceeds(p0, p1, p3) && !deviation_exceeds(p0, p2, p3)) {
        out.push(p3);
        return;
    }
    let (a, b, c, d, split) = split_cubic(p0, p1, p2, p3);
    flatten_cubic(p0, a, b, split, out, depth + 1);
    flatten_cubic(split, c, d, p3, out, depth + 1);
}

fn split_cubic(
    p0: PointQ16,
    p1: PointQ16,
    p2: PointQ16,
    p3: PointQ16,
) -> (PointQ16, PointQ16, PointQ16, PointQ16, PointQ16) {
    let m01 = midpoint(p0, p1);
    let m12 = midpoint(p1, p2);
    let m23 = midpoint(p2, p3);
    let m012 = midpoint(m01, m12);
    let m123 = midpoint(m12, m23);
    let split = midpoint(m012, m123);
    (m01, m012, m123, m23, split)
}

fn pixel_bounds(bounds: (i32, i32, i32, i32)) -> Rect {
    Rect {
        x1: floor_div(bounds.0, 256),
        y1: floor_div(bounds.1, 256),
        x2: ceil_div(bounds.2, 256) - 1,
        y2: ceil_div(bounds.3, 256) - 1,
    }
}

fn floor_div(value: i32, divisor: i32) -> i32 {
    value.div_euclid(divisor)
}

fn ceil_div(value: i32, divisor: i32) -> i32 {
    -((-value).div_euclid(divisor))
}

fn empty_rect() -> Rect {
    Rect {
        x1: 0,
        y1: 0,
        x2: -1,
        y2: -1,
    }
}

#[derive(Clone, Copy, Debug)]
struct RasterEdge {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    dir: i32,
}

impl RasterEdge {
    fn from_q8(edge: &EdgeQ8) -> Option<Self> {
        if edge.y0 == edge.y1 {
            return None;
        }
        Some(RasterEdge {
            x0: edge.x0 as f64 / 256.0,
            y0: edge.y0 as f64 / 256.0,
            x1: edge.x1 as f64 / 256.0,
            y1: edge.y1 as f64 / 256.0,
            dir: if edge.y1 > edge.y0 { 1 } else { -1 },
        })
    }

    fn y_range(&self) -> (f64, f64) {
        if self.y0 < self.y1 {
            (self.y0, self.y1)
        } else {
            (self.y1, self.y0)
        }
    }

    fn x_at(&self, y: f64) -> f64 {
        self.x0 + (self.x1 - self.x0) * (y - self.y0) / (self.y1 - self.y0)
    }
}

// Area accumulator: decision 61 fixes analytic `f64` for 0.1.0. Edge inputs are
// 8.8 integers, and every §12 golden value and frozen fixture matches. The `i128`
// accumulator is deferred beyond 0.1.0 and is not a release blocker.
#[derive(Default)]
pub(crate) struct RasterScratch {
    area: Vec<f64>,
    covers: Vec<u16>,
    active: Vec<usize>,
    splits: Vec<f64>,
    crossings: Vec<(f64, i32, usize)>,
}

impl RasterScratch {
    /// Grows the reusable coverage row to `width`; `Engine` keeps it between draws.
    fn ensure(&mut self, width: usize) {
        if self.area.len() < width {
            self.area.resize(width, 0.0);
            self.covers.resize(width, 0);
        }
    }

    /// Sizes the row to the frame width; capacity is retained across frames.
    pub(crate) fn fit(&mut self, width: usize) {
        self.area.resize(width, 0.0);
        self.covers.resize(width, 0);
    }
}

fn cover_from_area(area: f64) -> u16 {
    let cover = (area * 256.0 + 0.5).floor();
    cover.clamp(0.0, 256.0) as u16
}

fn intersection_y(a: &RasterEdge, b: &RasterEdge, top: f64, bottom: f64) -> Option<f64> {
    let ax = a.x1 - a.x0;
    let ay = a.y1 - a.y0;
    let bx = b.x1 - b.x0;
    let by = b.y1 - b.y0;
    let den = ax * by - ay * bx;
    if den.abs() < 1e-12 {
        return None;
    }
    let t = ((b.x0 - a.x0) * by - (b.y0 - a.y0) * bx) / den;
    let u = ((b.x0 - a.x0) * ay - (b.y0 - a.y0) * ax) / den;
    if !(0.0..=1.0).contains(&t) || !(0.0..=1.0).contains(&u) {
        return None;
    }
    let y = a.y0 + t * ay;
    (y > top + 1e-9 && y < bottom - 1e-9).then_some(y)
}

fn row_coverage(
    edges: &[RasterEdge],
    rule: FillRule,
    row: i32,
    x_start: i32,
    x_end: i32,
    scratch: &mut RasterScratch,
) {
    let width = (x_end - x_start + 1) as usize;
    scratch.ensure(width);
    let RasterScratch {
        area,
        covers,
        active,
        splits,
        crossings,
    } = scratch;
    let area = &mut area[..width];
    let covers = &mut covers[..width];
    area.fill(0.0);
    covers.fill(0);
    active.clear();
    splits.clear();

    let top = row as f64;
    let bottom = top + 1.0;
    for (index, edge) in edges.iter().enumerate() {
        let (lo, hi) = edge.y_range();
        if hi > top && lo < bottom {
            active.push(index);
        }
    }
    if active.len() < 2 {
        return;
    }

    splits.push(top);
    splits.push(bottom);
    for &index in active.iter() {
        let edge = &edges[index];
        for y in [edge.y0, edge.y1] {
            if y > top && y < bottom {
                splits.push(y);
            }
        }
    }
    for a in 0..active.len() {
        for b in a + 1..active.len() {
            if let Some(y) = intersection_y(&edges[active[a]], &edges[active[b]], top, bottom) {
                splits.push(y);
            }
        }
    }
    splits.sort_by(f64::total_cmp);
    splits.dedup_by(|a, b| (*a - *b).abs() <= 1e-9);

    for window in splits.windows(2) {
        let ya = window[0];
        let yb = window[1];
        if yb - ya <= AREA_EPS {
            continue;
        }
        let mid = (ya + yb) * 0.5;
        crossings.clear();
        for &index in active.iter() {
            let edge = &edges[index];
            let (lo, hi) = edge.y_range();
            if lo <= mid && mid <= hi {
                crossings.push((edge.x_at(mid), edge.dir, index));
            }
        }
        crossings.sort_by(|a, b| {
            a.0.total_cmp(&b.0)
                .then_with(|| a.1.cmp(&b.1))
                .then_with(|| a.2.cmp(&b.2))
        });

        let mut winding = 0_i32;
        for i in 0..crossings.len().saturating_sub(1) {
            winding += crossings[i].1;
            let inside = match rule {
                FillRule::NonZero => winding != 0,
                FillRule::EvenOdd => winding & 1 != 0,
            };
            if !inside {
                continue;
            }
            let left_edge = &edges[crossings[i].2];
            let right_edge = &edges[crossings[i + 1].2];
            distribute(area, x_start, x_end, left_edge, right_edge, ya, yb);
        }
    }

    for (index, value) in area.iter().enumerate() {
        covers[index] = cover_from_area(*value);
    }
}

fn distribute(
    area: &mut [f64],
    x_start: i32,
    x_end: i32,
    left: &RasterEdge,
    right: &RasterEdge,
    ya: f64,
    yb: f64,
) {
    let xl_a = left.x_at(ya);
    let xl_b = left.x_at(yb);
    let xr_a = right.x_at(ya);
    let xr_b = right.x_at(yb);
    let x_min = xl_a.min(xl_b).min(xr_a).min(xr_b);
    let x_max = xl_a.max(xl_b).max(xr_a).max(xr_b);
    let c_start = (x_min.floor() as i32).max(x_start);
    let c_end = (x_max.floor() as i32).min(x_end);
    if c_start > c_end {
        return;
    }
    for column in c_start..=c_end {
        let piece = clipped_area(xl_a, xl_b, xr_a, xr_b, ya, yb, column as f64);
        if piece > 0.0 {
            area[(column - x_start) as usize] += piece;
        }
    }
}

fn clipped_area(xl_a: f64, xl_b: f64, xr_a: f64, xr_b: f64, ya: f64, yb: f64, c: f64) -> f64 {
    let lo = c;
    let hi = c + 1.0;
    let mut ys = [0.0_f64; 6];
    let mut count = 2;
    ys[0] = ya;
    ys[1] = yb;
    for (a, b) in [(xl_a, xl_b), (xr_a, xr_b)] {
        let delta = b - a;
        if delta.abs() > 1e-15 {
            for bound in [lo, hi] {
                let y = ya + (bound - a) * (yb - ya) / delta;
                if y > ya && y < yb && count < ys.len() {
                    ys[count] = y;
                    count += 1;
                }
            }
        }
    }
    for i in 1..count {
        let value = ys[i];
        let mut j = i;
        while j > 0 && ys[j - 1] > value {
            ys[j] = ys[j - 1];
            j -= 1;
        }
        ys[j] = value;
    }
    let mut unique = 0;
    for i in 0..count {
        if unique == 0 || (ys[i] - ys[unique - 1]).abs() > 1e-9 {
            ys[unique] = ys[i];
            unique += 1;
        }
    }

    let width = |y: f64| {
        let t = (y - ya) / (yb - ya);
        let xl = xl_a + (xl_b - xl_a) * t;
        let xr = xr_a + (xr_b - xr_a) * t;
        (xr.min(hi) - xl.max(lo)).max(0.0)
    };
    let mut area = 0.0;
    for i in 1..unique {
        let y0 = ys[i - 1];
        let y1 = ys[i];
        if y1 - y0 <= AREA_EPS {
            continue;
        }
        if width((y0 + y1) * 0.5) > 0.0 {
            area += (width(y0) + width(y1)) * 0.5 * (y1 - y0);
        }
    }
    area
}

fn paint_rect(bytes: &mut [u8], stride: usize, rect: Rect, color: Color, blend: Blend) {
    for y in rect.y1..=rect.y2 {
        let start = y as usize * stride;
        let row = &mut bytes[start..start + stride];
        span::paint(row, rect.x1, rect.x2, color, span::FULL_COVER, blend);
    }
}

/// `Measure` for the fill branch (`fgce.md` §5.1).
pub(crate) fn measure_with(
    verbs: &[Verb],
    rule: FillRule,
    scratch: &mut RasterScratch,
) -> Result<Rect, Error> {
    let path = Path::parse(verbs)?;
    if !path.has_area() {
        return Ok(empty_rect());
    }
    let Some(bounds) = path.bounds() else {
        return Ok(empty_rect());
    };
    let rect = pixel_bounds(bounds);
    if rect.is_empty() {
        return Ok(empty_rect());
    }
    if path.single_rectangle().is_some() {
        return Ok(rect);
    }
    let edges: Vec<RasterEdge> = path
        .edges(true)
        .iter()
        .filter_map(RasterEdge::from_q8)
        .collect();
    Ok(covered_bounds(&edges, rule, rect, scratch))
}

/// Inclusive bounds of the pixels the rasterizer really paints.
///
/// Exact by `cover > 0`: geometric bounds would include sub-1/512 edges that
/// paint nothing. The cost is proportional to the path's pixel area, accepted
/// for `0.1.0` because hosts keep paths inside their box (decision 62).
fn covered_bounds(
    edges: &[RasterEdge],
    rule: FillRule,
    rect: Rect,
    scratch: &mut RasterScratch,
) -> Rect {
    if edges.is_empty() {
        return empty_rect();
    }
    let width = (rect.x2 - rect.x1 + 1) as usize;
    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    let mut max_x = i32::MIN;
    let mut max_y = i32::MIN;
    let mut painted = false;
    for y in rect.y1..=rect.y2 {
        row_coverage(edges, rule, y, rect.x1, rect.x2, scratch);
        for (index, &cover) in scratch.covers[..width].iter().enumerate() {
            if cover > 0 {
                let x = rect.x1 + index as i32;
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
                painted = true;
            }
        }
    }
    if painted {
        Rect {
            x1: min_x,
            y1: min_y,
            x2: max_x,
            y2: max_y,
        }
    } else {
        empty_rect()
    }
}

/// Fills an orthogonal path with exact row spans (`fgce.md` §11.3).
fn fill_orthogonal(
    bytes: &mut [u8],
    stride: usize,
    target: Rect,
    path: &Path,
    rule: FillRule,
    color: Color,
    blend: Blend,
) {
    let edges = path.edges(true);
    let mut crossings: Vec<(i32, i32)> = Vec::new();
    for y in target.y1..=target.y2 {
        crossings.clear();
        let top = y * 256;
        let bottom = top + 256;
        for edge in &edges {
            if edge.x0 != edge.x1 {
                continue;
            }
            let lo = edge.y0.min(edge.y1);
            let hi = edge.y0.max(edge.y1);
            if hi > top && lo < bottom {
                let direction = if edge.y1 > edge.y0 { 1 } else { -1 };
                crossings.push((edge.x0 / 256, direction));
            }
        }
        crossings.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
        let mut winding = 0_i32;
        let row_start = y as usize * stride;
        let row = &mut bytes[row_start..row_start + stride];
        for i in 0..crossings.len().saturating_sub(1) {
            winding += crossings[i].1;
            let inside = match rule {
                FillRule::NonZero => winding != 0,
                FillRule::EvenOdd => winding & 1 != 0,
            };
            if !inside {
                continue;
            }
            let left = crossings[i].0.max(target.x1);
            let right = (crossings[i + 1].0 - 1).min(target.x2);
            if left <= right {
                span::paint(row, left, right, color, span::FULL_COVER, blend);
            }
        }
    }
}

/// Fills a path clipped to `clip` (`fgce.md` §8.3).
#[allow(clippy::too_many_arguments)]
pub(crate) fn fill_path(
    bytes: &mut [u8],
    stride: usize,
    clip: Rect,
    verbs: &[Verb],
    rule: FillRule,
    color: Color,
    blend: Blend,
    scratch: &mut RasterScratch,
) -> Result<(), Error> {
    let path = Path::parse(verbs)?;
    if !path.has_area() {
        return Ok(());
    }
    let Some(bounds) = path.bounds() else {
        return Ok(());
    };
    let target = pixel_bounds(bounds).intersect(clip);
    if target.is_empty() {
        return Ok(());
    }
    if path.single_rectangle().is_some() {
        paint_rect(bytes, stride, target, color, blend);
        return Ok(());
    }
    if path.is_orthogonal() {
        fill_orthogonal(bytes, stride, target, &path, rule, color, blend);
        return Ok(());
    }

    let edges: Vec<RasterEdge> = path
        .edges(true)
        .iter()
        .filter_map(RasterEdge::from_q8)
        .collect();
    if edges.is_empty() {
        return Ok(());
    }

    let width = (target.x2 - target.x1 + 1) as usize;
    for y in target.y1..=target.y2 {
        row_coverage(&edges, rule, y, target.x1, target.x2, scratch);
        let start = y as usize * stride;
        let row = &mut bytes[start..start + stride];
        for (index, &cover) in scratch.covers[..width].iter().enumerate() {
            if cover > 0 {
                let x = target.x1 + index as i32;
                span::paint(row, x, x, color, cover, blend);
            }
        }
    }
    Ok(())
}

// Stroke outline (§8.4). The outline is built as polygons in 8.8 and painted by
// the shared coverage rasterizer; `Measure` reads the same geometry.

/// `cross² * 16 ≤ dx² + dy²` in sPx, expressed in 8.8 units.
const ARC_SPLIT_FACTOR: u128 = 4096;

#[derive(Clone, Copy)]
struct JoinRequest {
    vertex: PointQ8,
    normal_prev: (i128, i128),
    normal_next: (i128, i128),
    dir_prev: (i128, i128),
    dir_next: (i128, i128),
    width_q8: i128,
    width: u32,
}

fn point_from_q8(x: i128, y: i128) -> Result<PointQ8, Error> {
    if x < i32::MIN as i128 || x > i32::MAX as i128 || y < i32::MIN as i128 || y > i32::MAX as i128
    {
        return Err(Error::Overflow);
    }
    Ok(PointQ8 {
        x: x as i32,
        y: y as i32,
    })
}

fn div_round(value: i128, divisor: i128) -> i128 {
    let (value, divisor) = if divisor < 0 {
        (-value, -divisor)
    } else {
        (value, divisor)
    };
    let quotient = value / divisor;
    let remainder = value % divisor;
    if remainder.abs() * 2 >= divisor {
        quotient + value.signum()
    } else {
        quotient
    }
}

fn isqrt(value: u128) -> u128 {
    if value == 0 {
        return 0;
    }
    let mut current = value;
    let mut next = current.div_ceil(2);
    while next < current {
        current = next;
        next = (current + value / current) / 2;
    }
    current
}

fn push_point(points: &mut Vec<PointQ8>, point: PointQ8) {
    if points.last() != Some(&point) {
        points.push(point);
    }
}

fn unit_q8(from: PointQ8, to: PointQ8) -> Option<(i128, i128)> {
    let dx = (to.x - from.x) as i128;
    let dy = (to.y - from.y) as i128;
    let length = isqrt((dx * dx + dy * dy) as u128) as i128;
    (length != 0).then(|| (div_round(dx * 256, length), div_round(dy * 256, length)))
}

fn edge_normal(a: PointQ8, b: PointQ8, width_q8: i128, right: bool) -> Option<(i128, i128)> {
    let dx = (b.x - a.x) as i128;
    let dy = (b.y - a.y) as i128;
    let length = isqrt((dx * dx + dy * dy) as u128) as i128;
    if length == 0 {
        return None;
    }
    let (nx, ny) = if right { (-dy, dx) } else { (dy, -dx) };
    Some((
        div_round(nx * width_q8, length),
        div_round(ny * width_q8, length),
    ))
}

fn offset_vertex(point: PointQ8, normal: (i128, i128)) -> Result<PointQ8, Error> {
    point_from_q8(point.x as i128 + normal.0, point.y as i128 + normal.1)
}

fn signed_area(points: &[PointQ8]) -> i128 {
    let mut sum = 0_i128;
    for index in 0..points.len() {
        let a = points[index];
        let b = points[(index + 1) % points.len()];
        sum += a.x as i128 * b.y as i128 - b.x as i128 * a.y as i128;
    }
    sum
}

fn miter_intersection(
    a: PointQ8,
    da: (i128, i128),
    b: PointQ8,
    db: (i128, i128),
) -> Option<(i128, i128)> {
    let den = da.0 * db.1 - da.1 * db.0;
    if den == 0 {
        return None;
    }
    let num = (b.x as i128 - a.x as i128) * db.1 - (b.y as i128 - a.y as i128) * db.0;
    Some((
        a.x as i128 + div_round(num * da.0, den),
        a.y as i128 + div_round(num * da.1, den),
    ))
}

fn miter_fits(corner: (i128, i128), vertex: PointQ8, limit_q8: u32, width: u32) -> bool {
    let dx = corner.0 - vertex.x as i128;
    let dy = corner.1 - vertex.y as i128;
    let length_sq = dx * dx + dy * dy;
    let limit = limit_q8 as u128 * width as u128;
    length_sq as u128 <= limit * limit
}

fn arc_mid(center: PointQ8, p0: PointQ8, p1: PointQ8, radius_q8: i128) -> Result<PointQ8, Error> {
    let ux0 = p0.x as i128 - center.x as i128;
    let uy0 = p0.y as i128 - center.y as i128;
    let ux1 = p1.x as i128 - center.x as i128;
    let uy1 = p1.y as i128 - center.y as i128;
    let l0 = isqrt((ux0 * ux0 + uy0 * uy0) as u128) as i128;
    let l1 = isqrt((ux1 * ux1 + uy1 * uy1) as u128) as i128;
    if l0 == 0 || l1 == 0 {
        return Ok(p0);
    }
    let (mut sx, mut sy) = (ux0 * l1 + ux1 * l0, uy0 * l1 + uy1 * l0);
    if sx == 0 && sy == 0 {
        // A half turn has no bisector; the stroke continues along the incoming edge.
        sx = uy0;
        sy = -ux0;
    }
    let length = isqrt((sx * sx + sy * sy) as u128) as i128;
    if length == 0 {
        return Ok(p0);
    }
    point_from_q8(
        center.x as i128 + div_round(radius_q8 * sx, length),
        center.y as i128 + div_round(radius_q8 * sy, length),
    )
}

fn arc_splits(p0: PointQ8, control: PointQ8, p1: PointQ8) -> bool {
    let dx = (p1.x - p0.x) as i128;
    let dy = (p1.y - p0.y) as i128;
    let vx = (control.x - p0.x) as i128;
    let vy = (control.y - p0.y) as i128;
    let cross = dx * vy - dy * vx;
    let chord_sq = dx * dx + dy * dy;
    if chord_sq == 0 {
        return false;
    }
    let lhs = cross.unsigned_abs().saturating_mul(cross.unsigned_abs());
    lhs > chord_sq as u128 * ARC_SPLIT_FACTOR
}

fn arc_into(
    out: &mut Vec<PointQ8>,
    center: PointQ8,
    p0: PointQ8,
    p1: PointQ8,
    radius_q8: i128,
    depth: u32,
) -> Result<(), Error> {
    if depth >= MAX_DEPTH || p0 == p1 {
        return Ok(());
    }
    let control = arc_mid(center, p0, p1, radius_q8)?;
    if control == p0 || control == p1 || !arc_splits(p0, control, p1) {
        return Ok(());
    }
    arc_into(out, center, p0, control, radius_q8, depth + 1)?;
    push_point(out, control);
    arc_into(out, center, control, p1, radius_q8, depth + 1)
}

fn join_points(out: &mut Vec<PointQ8>, request: &JoinRequest, join: Join) -> Result<(), Error> {
    if request.normal_prev == request.normal_next {
        push_point(out, offset_vertex(request.vertex, request.normal_prev)?);
        return Ok(());
    }
    match join {
        Join::Miter { limit_q8 } => {
            let a = offset_vertex(request.vertex, request.normal_prev)?;
            let b = offset_vertex(request.vertex, request.normal_next)?;
            let Some(corner) = miter_intersection(a, request.dir_prev, b, request.dir_next) else {
                push_point(out, a);
                push_point(out, b);
                return Ok(());
            };
            if miter_fits(corner, request.vertex, limit_q8, request.width) {
                push_point(out, point_from_q8(corner.0, corner.1)?);
            } else {
                push_point(out, a);
                push_point(out, b);
            }
        }
        Join::Bevel => {
            push_point(out, offset_vertex(request.vertex, request.normal_prev)?);
            push_point(out, offset_vertex(request.vertex, request.normal_next)?);
        }
        Join::Round => {
            let a = offset_vertex(request.vertex, request.normal_prev)?;
            let b = offset_vertex(request.vertex, request.normal_next)?;
            push_point(out, a);
            arc_into(out, request.vertex, a, b, request.width_q8, 0)?;
            push_point(out, b);
        }
    }
    Ok(())
}

fn offset_chain(
    points: &[PointQ8],
    closed: bool,
    right: bool,
    width_q8: i128,
    width: u32,
    join: Join,
) -> Result<Vec<PointQ8>, Error> {
    let count = points.len();
    let edge_count = if closed { count } else { count - 1 };
    let mut normals = Vec::with_capacity(edge_count);
    for index in 0..edge_count {
        let next = if closed {
            (index + 1) % count
        } else {
            index + 1
        };
        normals
            .push(edge_normal(points[index], points[next], width_q8, right).ok_or(Error::BadPath)?);
    }

    let mut out = Vec::new();
    for index in 0..edge_count {
        if index == 0 && !closed {
            push_point(&mut out, offset_vertex(points[0], normals[0])?);
            continue;
        }
        let previous = (index + edge_count - 1) % edge_count;
        let vertex = points[index];
        let dir_prev = if index == 0 {
            (
                points[0].x as i128 - points[count - 1].x as i128,
                points[0].y as i128 - points[count - 1].y as i128,
            )
        } else {
            (
                points[index].x as i128 - points[index - 1].x as i128,
                points[index].y as i128 - points[index - 1].y as i128,
            )
        };
        let dir_next = if index + 1 == count {
            (
                points[0].x as i128 - points[index].x as i128,
                points[0].y as i128 - points[index].y as i128,
            )
        } else {
            (
                points[index + 1].x as i128 - points[index].x as i128,
                points[index + 1].y as i128 - points[index].y as i128,
            )
        };
        join_points(
            &mut out,
            &JoinRequest {
                vertex,
                normal_prev: normals[previous],
                normal_next: normals[index],
                dir_prev,
                dir_next,
                width_q8,
                width,
            },
            join,
        )?;
    }
    if !closed {
        push_point(
            &mut out,
            offset_vertex(points[count - 1], normals[edge_count - 1])?,
        );
    }
    Ok(out)
}

fn append_end_cap(
    polygon: &mut Vec<PointQ8>,
    points: &[PointQ8],
    offset: &[PointQ8],
    cap: Cap,
    width_q8: i128,
) -> Result<(), Error> {
    if cap == Cap::Butt {
        return Ok(());
    }
    let last = points.len() - 1;
    let Some(direction) = unit_q8(points[last - 1], points[last]) else {
        return Ok(());
    };
    let vertex = points[last];
    let width = width_q8 / 256;
    let tip = point_from_q8(
        vertex.x as i128 + direction.0 * width,
        vertex.y as i128 + direction.1 * width,
    )?;
    let corner = *offset.last().expect("offset chain is non-empty");
    match cap {
        Cap::Butt => {}
        Cap::Square => {
            push_point(polygon, tip);
            push_point(
                polygon,
                point_from_q8(
                    corner.x as i128 + direction.0 * width,
                    corner.y as i128 + direction.1 * width,
                )?,
            );
        }
        Cap::Round => {
            push_point(polygon, tip);
            arc_into(polygon, vertex, tip, corner, width_q8, 0)?;
        }
    }
    Ok(())
}

fn append_start_cap(
    polygon: &mut Vec<PointQ8>,
    points: &[PointQ8],
    offset: &[PointQ8],
    cap: Cap,
    width_q8: i128,
) -> Result<(), Error> {
    if cap == Cap::Butt {
        return Ok(());
    }
    let Some(direction) = unit_q8(points[1], points[0]) else {
        return Ok(());
    };
    let vertex = points[0];
    let width = width_q8 / 256;
    let tip = point_from_q8(
        vertex.x as i128 + direction.0 * width,
        vertex.y as i128 + direction.1 * width,
    )?;
    let corner = *offset.first().expect("offset chain is non-empty");
    match cap {
        Cap::Butt => {}
        Cap::Square => {
            push_point(
                polygon,
                point_from_q8(
                    corner.x as i128 + direction.0 * width,
                    corner.y as i128 + direction.1 * width,
                )?,
            );
            push_point(polygon, tip);
        }
        Cap::Round => {
            arc_into(polygon, vertex, corner, tip, width_q8, 0)?;
            push_point(polygon, tip);
        }
    }
    Ok(())
}

fn build_stroke(path: &Path, stroke: &Stroke) -> Result<Vec<Contour>, Error> {
    let width_q8 = stroke.width as i128 * 256;
    let mut contours = Vec::new();
    for contour in &path.contours {
        let mut points = contour.points.clone();
        let mut closed = contour.closed;
        if points.len() > 1 && points.first() == points.last() {
            points.pop();
            closed = true;
        }
        if points.len() < 2 {
            continue;
        }
        if stroke.align == StrokeAlign::Inside && !closed {
            return Err(Error::BadPath);
        }
        let area = signed_area(&points);
        let closed = closed && area != 0 && points.len() >= 3;
        if stroke.align == StrokeAlign::Inside && !closed {
            return Err(Error::BadPath);
        }
        let right = if closed {
            match stroke.align {
                StrokeAlign::Inside => area > 0,
                StrokeAlign::Outside => area < 0,
            }
        } else {
            true
        };
        let offset = offset_chain(&points, closed, right, width_q8, stroke.width, stroke.join)?;
        if closed {
            contours.push(Contour {
                points: points.clone(),
                closed: true,
            });
            let mut reversed = offset;
            reversed.reverse();
            if reversed.len() >= 3 {
                contours.push(Contour {
                    points: reversed,
                    closed: true,
                });
            }
        } else {
            let mut polygon = points.clone();
            append_end_cap(&mut polygon, &points, &offset, stroke.cap, width_q8)?;
            for point in offset.iter().rev() {
                push_point(&mut polygon, *point);
            }
            append_start_cap(&mut polygon, &points, &offset, stroke.cap, width_q8)?;
            if polygon.len() >= 3 {
                contours.push(Contour {
                    points: polygon,
                    closed: true,
                });
            }
        }
    }
    Ok(contours)
}

fn stroke_outline(verbs: &[Verb], stroke: &Stroke) -> Result<Vec<Contour>, Error> {
    if stroke.width == 0 {
        return Err(Error::BadStroke);
    }
    let path = Path::parse(verbs)?;
    build_stroke(&path, stroke)
}

/// Strokes a path clipped to `clip` (`fgce.md` §8.4).
#[allow(clippy::too_many_arguments)]
pub(crate) fn stroke_path(
    bytes: &mut [u8],
    stride: usize,
    clip: Rect,
    verbs: &[Verb],
    stroke: &Stroke,
    color: Color,
    blend: Blend,
    scratch: &mut RasterScratch,
) -> Result<(), Error> {
    let contours = stroke_outline(verbs, stroke)?;
    if contours.is_empty() {
        return Ok(());
    }
    let outline = Path { contours };
    let Some(bounds) = outline.bounds() else {
        return Ok(());
    };
    let target = pixel_bounds(bounds).intersect(clip);
    if target.is_empty() {
        return Ok(());
    }
    if outline.is_orthogonal() {
        fill_orthogonal(
            bytes,
            stride,
            target,
            &outline,
            FillRule::NonZero,
            color,
            blend,
        );
        return Ok(());
    }
    let edges: Vec<RasterEdge> = outline
        .edges(true)
        .iter()
        .filter_map(RasterEdge::from_q8)
        .collect();
    if edges.is_empty() {
        return Ok(());
    }
    let width = (target.x2 - target.x1 + 1) as usize;
    for y in target.y1..=target.y2 {
        row_coverage(&edges, FillRule::NonZero, y, target.x1, target.x2, scratch);
        let start = y as usize * stride;
        let row = &mut bytes[start..start + stride];
        for (index, &cover) in scratch.covers[..width].iter().enumerate() {
            if cover > 0 {
                let x = target.x1 + index as i32;
                span::paint(row, x, x, color, cover, blend);
            }
        }
    }
    Ok(())
}

/// `Measure` for the stroke branch (`fgce.md` §5.1).
pub(crate) fn measure_stroke_with(
    verbs: &[Verb],
    stroke: &Stroke,
    scratch: &mut RasterScratch,
) -> Result<Rect, Error> {
    let contours = stroke_outline(verbs, stroke)?;
    if contours.is_empty() {
        return Ok(empty_rect());
    }
    let outline = Path { contours };
    let Some(bounds) = outline.bounds() else {
        return Ok(empty_rect());
    };
    let rect = pixel_bounds(bounds);
    if rect.is_empty() {
        return Ok(empty_rect());
    }
    let edges: Vec<RasterEdge> = outline
        .edges(true)
        .iter()
        .filter_map(RasterEdge::from_q8)
        .collect();
    Ok(covered_bounds(&edges, FillRule::NonZero, rect, scratch))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Engine;
    use crate::contract::{AlphaMode, Fill, Request, Response, Stroke, StrokeAlign};
    use crate::contract::{Cap, Join};

    // Unit tests use a fresh row; conformance exercises the engine-owned one.
    fn measure(verbs: &[Verb], rule: FillRule) -> Result<Rect, Error> {
        super::measure_with(verbs, rule, &mut RasterScratch::default())
    }

    fn measure_stroke(verbs: &[Verb], stroke: &Stroke) -> Result<Rect, Error> {
        super::measure_stroke_with(verbs, stroke, &mut RasterScratch::default())
    }

    fn path_bounds(points: &[PointQ16]) -> (i64, i64, i64, i64) {
        let mut min_x = i64::MAX;
        let mut min_y = i64::MAX;
        let mut max_x = i64::MIN;
        let mut max_y = i64::MIN;
        for point in points {
            min_x = min_x.min(point.x);
            min_y = min_y.min(point.y);
            max_x = max_x.max(point.x);
            max_y = max_y.max(point.y);
        }
        (min_x, min_y, max_x, max_y)
    }

    fn q16(x: i32, y: i32) -> PointQ16 {
        point_q16(x, y)
    }

    fn engine() -> Engine {
        let mut engine = Engine::new();
        engine
            .submit(Request::Begin {
                width: 16,
                height: 16,
            })
            .unwrap();
        engine
    }

    fn pixel(engine: &mut Engine, x: i32, y: i32) -> [u8; 4] {
        let response = engine
            .submit(Request::ReadPixels {
                rect: Rect {
                    x1: x,
                    y1: y,
                    x2: x,
                    y2: y,
                },
                alpha: AlphaMode::Premul,
            })
            .unwrap();
        let Response::Pixels(pixels) = response else {
            panic!("expected pixels");
        };
        pixels.bytes[0..4].try_into().unwrap()
    }

    fn fill(engine: &mut Engine, verbs: &[Verb], rule: FillRule, color: Color) {
        engine
            .submit(Request::FillPath {
                verbs,
                rule,
                color,
                blend: None,
            })
            .unwrap();
    }

    fn white() -> Color {
        Color {
            r: 255,
            g: 255,
            b: 255,
            a: 255,
        }
    }

    fn rectangle(x1: i32, y1: i32, x2: i32, y2: i32) -> [Verb; 5] {
        [
            Verb::Move(x1, y1),
            Verb::Line(x2, y1),
            Verb::Line(x2, y2),
            Verb::Line(x1, y2),
            Verb::Close,
        ]
    }

    #[test]
    fn quad_not_split() {
        let mut points = Vec::new();
        flatten_quad(q16(0, 0), q16(1, 1), q16(3, 4), &mut points, 0);
        assert_eq!(points, [q16(3, 4)]);
    }

    #[test]
    fn quad_splits_and_first_split_is_exact() {
        let (m01, m12, split) = split_quad(q16(0, 0), q16(1, 0), q16(3, 4));
        assert_eq!(m01, PointQ16 { x: 32768, y: 0 });
        assert_eq!(m12, q16(2, 2));
        assert_eq!(split, PointQ16 { x: 81920, y: 65536 });

        let mut points = Vec::new();
        flatten_quad(q16(0, 0), q16(1, 0), q16(3, 4), &mut points, 0);
        assert!(points.len() > 1);
        assert_eq!(points.last(), Some(&q16(3, 4)));
        let mut all = vec![q16(0, 0)];
        all.extend(points);
        let bounds = path_bounds(&all);
        assert_eq!(bounds, (0, 0, 3 << 16, 4 << 16));
    }

    #[test]
    fn cubic_not_split() {
        let mut points = Vec::new();
        flatten_cubic(q16(0, 0), q16(1, 1), q16(2, 2), q16(3, 3), &mut points, 0);
        assert_eq!(points, [q16(3, 3)]);
    }

    #[test]
    fn cubic_first_split_is_exact() {
        let (m01, m012, m123, m23, split) = split_cubic(q16(0, 0), q16(0, 0), q16(4, 0), q16(4, 4));
        assert_eq!(m01, q16(0, 0));
        assert_eq!(m012, q16(1, 0));
        assert_eq!(m123, q16(3, 1));
        assert_eq!(m23, q16(4, 2));
        assert_eq!(
            split,
            PointQ16 {
                x: 131072,
                y: 32768
            }
        );

        let mut points = Vec::new();
        flatten_cubic(q16(0, 0), q16(0, 4), q16(4, 4), q16(4, 0), &mut points, 0);
        assert!(points.len() > 1);
        assert_eq!(points.last(), Some(&q16(4, 0)));
    }

    #[test]
    fn fill_cubic_path() {
        let verbs = [
            Verb::Move(0, 0),
            Verb::Cubic(0, 4, 4, 4, 4, 0),
            Verb::Line(0, 0),
            Verb::Close,
        ];
        let mut engine = engine();
        fill(&mut engine, &verbs, FillRule::NonZero, white());
        assert_eq!(pixel(&mut engine, 2, 1), [255, 255, 255, 255]);
        assert_eq!(pixel(&mut engine, 5, 5), [0, 0, 0, 0]);
        let rect = measure(&verbs, FillRule::NonZero).unwrap();
        assert!(!rect.is_empty());
        assert!(rect.x1 == 0 && rect.x2 >= 2);
    }

    #[test]
    fn coverage_rounding() {
        assert_eq!(cover_from_area(1.0 / 512.0), 1);
        assert_eq!(cover_from_area(0.5), 128);
        assert_eq!(cover_from_area(15.0 / 16.0), 240);
        assert_eq!(cover_from_area(1.0), 256);
    }

    #[test]
    fn raster_scratch_is_one_row() {
        let mut scratch = RasterScratch::default();
        assert!(scratch.area.is_empty(), "the engine starts without a row");
        scratch.ensure(17);
        assert_eq!(scratch.area.len(), 17, "one coverage row, not a frame");
        assert_eq!(scratch.covers.len(), 17, "one cover row, not a frame");
        scratch.ensure(9);
        assert_eq!(scratch.area.len(), 17, "ensure grows only");
        scratch.fit(9);
        assert_eq!(scratch.area.len(), 9, "Begin sizes the row to the frame");
        assert!(scratch.active.is_empty());
        assert!(scratch.splits.is_empty());
        assert!(scratch.crossings.is_empty());
    }

    #[test]
    fn q16_rounding_is_to_nearest_ties_away() {
        assert_eq!(q16_to_q8(127), 0);
        assert_eq!(q16_to_q8(128), 1);
        assert_eq!(q16_to_q8(383), 1);
        assert_eq!(q16_to_q8(384), 2);
        assert_eq!(q16_to_q8(-127), 0);
        assert_eq!(q16_to_q8(-128), -1);
        assert_eq!(q16_to_q8(-383), -1);
        assert_eq!(q16_to_q8(-384), -2);
        assert_eq!(q16_to_q8(256), 1);
    }

    #[test]
    fn path_rectangle_matches_fill_rect() {
        let mut vector = engine();
        fill(
            &mut vector,
            &rectangle(0, 0, 10, 10),
            FillRule::NonZero,
            white(),
        );

        let mut rect = engine();
        rect.submit(Request::FillRect {
            rect: Rect {
                x1: 0,
                y1: 0,
                x2: 9,
                y2: 9,
            },
            color: white(),
            blend: None,
        })
        .unwrap();

        for y in 0..16 {
            for x in 0..16 {
                assert_eq!(pixel(&mut vector, x, y), pixel(&mut rect, x, y));
            }
        }
    }

    #[test]
    fn retraced_contour_is_not_a_rectangle() {
        let verbs = [
            Verb::Move(0, 0),
            Verb::Line(0, 10),
            Verb::Line(10, 10),
            Verb::Line(0, 10),
            Verb::Close,
        ];
        let mut engine = engine();
        fill(&mut engine, &verbs, FillRule::NonZero, white());
        assert_eq!(pixel(&mut engine, 0, 0), [0, 0, 0, 0]);
        assert_eq!(pixel(&mut engine, 5, 5), [0, 0, 0, 0]);
        assert!(measure(&verbs, FillRule::NonZero).unwrap().is_empty());
    }

    #[test]
    fn fill_triangle_without_close_equals_with_close() {
        let open = [Verb::Move(0, 0), Verb::Line(4, 0), Verb::Line(0, 4)];
        let closed = [
            Verb::Move(0, 0),
            Verb::Line(4, 0),
            Verb::Line(0, 4),
            Verb::Close,
        ];
        let mut a = engine();
        let mut b = engine();
        fill(&mut a, &open, FillRule::NonZero, white());
        fill(&mut b, &closed, FillRule::NonZero, white());
        for y in 0..16 {
            for x in 0..16 {
                assert_eq!(pixel(&mut a, x, y), pixel(&mut b, x, y));
            }
        }
    }

    #[test]
    fn fill_without_close_equals_with_close() {
        let open = [
            Verb::Move(1, 1),
            Verb::Line(9, 1),
            Verb::Line(9, 9),
            Verb::Line(1, 9),
        ];
        let closed = rectangle(1, 1, 9, 9);
        let mut a = engine();
        let mut b = engine();
        fill(&mut a, &open, FillRule::NonZero, white());
        fill(&mut b, &closed, FillRule::NonZero, white());
        for y in 0..16 {
            for x in 0..16 {
                assert_eq!(pixel(&mut a, x, y), pixel(&mut b, x, y));
            }
        }
    }

    #[test]
    fn triangle_half_coverage() {
        let mut engine = engine();
        fill(
            &mut engine,
            &[
                Verb::Move(0, 0),
                Verb::Line(4, 0),
                Verb::Line(0, 4),
                Verb::Close,
            ],
            FillRule::NonZero,
            white(),
        );
        assert_eq!(pixel(&mut engine, 3, 0), [128, 128, 128, 128]);
        assert_eq!(pixel(&mut engine, 0, 0), [255, 255, 255, 255]);
        assert_eq!(pixel(&mut engine, 4, 0), [0, 0, 0, 0]);
    }

    #[test]
    fn triangle_shallow_edge_area() {
        let mut engine = engine();
        fill(
            &mut engine,
            &[
                Verb::Move(0, 0),
                Verb::Line(8, 1),
                Verb::Line(0, 1),
                Verb::Close,
            ],
            FillRule::NonZero,
            white(),
        );
        assert_eq!(pixel(&mut engine, 0, 0)[3], 239);
    }

    #[test]
    fn triangle_half_coverage_with_alpha() {
        let mut engine = engine();
        fill(
            &mut engine,
            &[
                Verb::Move(0, 0),
                Verb::Line(4, 0),
                Verb::Line(0, 4),
                Verb::Close,
            ],
            FillRule::NonZero,
            Color {
                r: 255,
                g: 0,
                b: 0,
                a: 128,
            },
        );
        assert_eq!(pixel(&mut engine, 3, 0), [64, 0, 0, 64]);
    }

    #[test]
    fn measure_rectangle() {
        let mut engine = Engine::new();
        let response = engine
            .submit(Request::Measure {
                verbs: &rectangle(0, 0, 10, 10),
                fill: Some(Fill {
                    rule: FillRule::NonZero,
                }),
                stroke: None,
            })
            .unwrap();
        let Response::Measure(rect) = response else {
            panic!("expected measure");
        };
        assert_eq!(
            rect,
            Rect {
                x1: 0,
                y1: 0,
                x2: 9,
                y2: 9
            }
        );
    }

    #[test]
    fn measure_move_only_is_empty() {
        let rect = measure(&[Verb::Move(3, 3)], FillRule::NonZero).unwrap();
        assert!(rect.is_empty());
    }

    #[test]
    fn measure_line_is_empty() {
        let rect = measure(&[Verb::Move(0, 0), Verb::Line(5, 5)], FillRule::NonZero).unwrap();
        assert!(rect.is_empty());
    }

    #[test]
    fn measure_respects_fill_rule() {
        let verbs = [
            Verb::Move(0, 0),
            Verb::Line(4, 0),
            Verb::Line(4, 4),
            Verb::Line(0, 4),
            Verb::Close,
            Verb::Move(0, 0),
            Verb::Line(4, 0),
            Verb::Line(4, 4),
            Verb::Line(0, 4),
            Verb::Close,
        ];
        assert!(measure(&verbs, FillRule::EvenOdd).unwrap().is_empty());
        assert_eq!(
            measure(&verbs, FillRule::NonZero).unwrap(),
            Rect {
                x1: 0,
                y1: 0,
                x2: 3,
                y2: 3
            }
        );
    }

    #[test]
    fn measure_returns_painted_bounds() {
        let verbs = [
            Verb::Move(0, 0),
            Verb::Line(6, 0),
            Verb::Line(6, 6),
            Verb::Line(0, 6),
            Verb::Close,
            Verb::Move(0, 0),
            Verb::Line(6, 0),
            Verb::Line(6, 1),
            Verb::Line(0, 1),
            Verb::Close,
        ];
        assert_eq!(
            measure(&verbs, FillRule::EvenOdd).unwrap(),
            Rect {
                x1: 0,
                y1: 1,
                x2: 5,
                y2: 5
            }
        );
        assert_eq!(
            measure(&verbs, FillRule::NonZero).unwrap(),
            Rect {
                x1: 0,
                y1: 0,
                x2: 5,
                y2: 5
            }
        );
    }

    #[test]
    fn measure_rejects_bad_branches_and_empty_path() {
        let empty = Engine::new()
            .submit(Request::Measure {
                verbs: &[],
                fill: Some(Fill {
                    rule: FillRule::NonZero,
                }),
                stroke: None,
            })
            .unwrap_err();
        assert_eq!(empty, Error::BadPath);

        let both = Engine::new()
            .submit(Request::Measure {
                verbs: &rectangle(0, 0, 1, 1),
                fill: Some(Fill {
                    rule: FillRule::NonZero,
                }),
                stroke: Some(Stroke {
                    width: 1,
                    align: StrokeAlign::Outside,
                    join: Join::Bevel,
                    cap: Cap::Butt,
                }),
            })
            .unwrap_err();
        assert_eq!(both, Error::BadPath);

        let mut engine = Engine::new();
        let stroke = engine
            .submit(Request::Measure {
                verbs: &rectangle(0, 0, 1, 1),
                fill: None,
                stroke: Some(Stroke {
                    width: 1,
                    align: StrokeAlign::Outside,
                    join: Join::Bevel,
                    cap: Cap::Butt,
                }),
            })
            .unwrap();
        let Response::Measure(rect) = stroke else {
            panic!("expected measure");
        };
        assert_eq!(
            rect,
            Rect {
                x1: -1,
                y1: -1,
                x2: 1,
                y2: 1
            }
        );
    }

    #[test]
    fn nonzero_and_evenodd_square_with_hole() {
        let verbs = [
            Verb::Move(0, 0),
            Verb::Line(6, 0),
            Verb::Line(6, 6),
            Verb::Line(0, 6),
            Verb::Close,
            Verb::Move(2, 2),
            Verb::Line(4, 2),
            Verb::Line(4, 4),
            Verb::Line(2, 4),
            Verb::Close,
        ];
        let mut nonzero = engine();
        fill(&mut nonzero, &verbs, FillRule::NonZero, white());
        let mut evenodd = engine();
        fill(&mut evenodd, &verbs, FillRule::EvenOdd, white());

        assert_eq!(pixel(&mut nonzero, 3, 3)[3], 255);
        assert_eq!(pixel(&mut evenodd, 3, 3)[3], 0);
        assert_eq!(pixel(&mut nonzero, 0, 0)[3], 255);
        assert_eq!(pixel(&mut evenodd, 0, 0)[3], 255);
    }

    #[test]
    fn winding_of_two_bands() {
        let same_direction = [
            Verb::Move(0, 0),
            Verb::Line(10, 0),
            Verb::Line(10, 10),
            Verb::Line(0, 10),
            Verb::Close,
            Verb::Move(5, 0),
            Verb::Line(15, 0),
            Verb::Line(15, 10),
            Verb::Line(5, 10),
            Verb::Close,
        ];
        let reverse = [
            Verb::Move(0, 0),
            Verb::Line(10, 0),
            Verb::Line(10, 10),
            Verb::Line(0, 10),
            Verb::Close,
            Verb::Move(5, 0),
            Verb::Line(5, 10),
            Verb::Line(15, 10),
            Verb::Line(15, 0),
            Verb::Close,
        ];
        let mut nonzero = engine();
        fill(&mut nonzero, &same_direction, FillRule::NonZero, white());
        let mut evenodd = engine();
        fill(&mut evenodd, &same_direction, FillRule::EvenOdd, white());
        let mut opposite = engine();
        fill(&mut opposite, &reverse, FillRule::NonZero, white());

        assert_eq!(pixel(&mut nonzero, 5, 0)[3], 255);
        assert_eq!(pixel(&mut evenodd, 5, 0)[3], 0);
        assert_eq!(pixel(&mut opposite, 5, 0)[3], 0);
    }

    #[test]
    fn bowtie_cover_sum() {
        let verbs = [
            Verb::Move(0, 0),
            Verb::Line(10, 10),
            Verb::Line(10, 0),
            Verb::Line(0, 10),
            Verb::Close,
        ];
        assert_eq!(cover_sum(&verbs, FillRule::NonZero), 50 * 256);
        assert_eq!(cover_sum(&verbs, FillRule::EvenOdd), 50 * 256);
    }

    fn cover_sum(verbs: &[Verb], rule: FillRule) -> u64 {
        let path = Path::parse(verbs).unwrap();
        let bounds = path.bounds().unwrap();
        let target = pixel_bounds(bounds);
        let edges: Vec<RasterEdge> = path
            .edges(true)
            .iter()
            .filter_map(RasterEdge::from_q8)
            .collect();
        let width = (target.x2 - target.x1 + 1) as usize;
        let mut scratch = RasterScratch::default();
        let mut sum = 0_u64;
        for y in target.y1..=target.y2 {
            row_coverage(&edges, rule, y, target.x1, target.x2, &mut scratch);
            sum += scratch.covers[..width]
                .iter()
                .map(|&c| c as u64)
                .sum::<u64>();
        }
        sum
    }

    #[test]
    fn fill_respects_clip() {
        let mut engine = engine();
        engine
            .submit(Request::ClipPush {
                rect: Rect {
                    x1: 2,
                    y1: 2,
                    x2: 4,
                    y2: 4,
                },
            })
            .unwrap();
        fill(
            &mut engine,
            &rectangle(0, 0, 8, 8),
            FillRule::NonZero,
            white(),
        );
        engine.submit(Request::ClipPop).unwrap();
        assert_eq!(pixel(&mut engine, 1, 1), [0, 0, 0, 0]);
        assert_eq!(pixel(&mut engine, 2, 2), [255, 255, 255, 255]);
        assert_eq!(pixel(&mut engine, 4, 4), [255, 255, 255, 255]);
        assert_eq!(pixel(&mut engine, 5, 5), [0, 0, 0, 0]);
    }

    #[test]
    fn general_rasterizer_respects_clip() {
        let mut engine = engine();
        engine
            .submit(Request::ClipPush {
                rect: Rect {
                    x1: 2,
                    y1: 2,
                    x2: 4,
                    y2: 4,
                },
            })
            .unwrap();
        fill(
            &mut engine,
            &[
                Verb::Move(0, 0),
                Verb::Line(8, 0),
                Verb::Line(0, 8),
                Verb::Close,
            ],
            FillRule::NonZero,
            white(),
        );
        engine.submit(Request::ClipPop).unwrap();
        assert_eq!(pixel(&mut engine, 1, 1), [0, 0, 0, 0]);
        assert_eq!(pixel(&mut engine, 2, 2), [255, 255, 255, 255]);
        assert_eq!(pixel(&mut engine, 5, 1), [0, 0, 0, 0]);
    }

    #[test]
    fn drawing_before_begin_is_not_begun() {
        let mut engine = Engine::new();
        let error = engine
            .submit(Request::FillPath {
                verbs: &rectangle(0, 0, 1, 1),
                rule: FillRule::NonZero,
                color: white(),
                blend: None,
            })
            .unwrap_err();
        assert_eq!(error, Error::NotBegun);
        let error = engine
            .submit(Request::StrokePath {
                verbs: &rectangle(0, 0, 1, 1),
                width: 1,
                align: StrokeAlign::Outside,
                join: Join::Bevel,
                cap: Cap::Butt,
                color: white(),
                blend: None,
            })
            .unwrap_err();
        assert_eq!(error, Error::NotBegun);
    }

    #[test]
    fn outside_pixel_does_not_read_destination() {
        let mut engine = engine();
        engine
            .submit(Request::FillRect {
                rect: Rect {
                    x1: 0,
                    y1: 0,
                    x2: 15,
                    y2: 15,
                },
                color: Color {
                    r: 0,
                    g: 0,
                    b: 255,
                    a: 255,
                },
                blend: None,
            })
            .unwrap();
        fill(
            &mut engine,
            &rectangle(1, 1, 3, 3),
            FillRule::NonZero,
            Color {
                r: 255,
                g: 0,
                b: 0,
                a: 255,
            },
        );
        assert_eq!(pixel(&mut engine, 0, 0), [0, 0, 255, 255]);
        assert_eq!(pixel(&mut engine, 1, 1), [255, 0, 0, 255]);
    }

    #[test]
    fn path_grammar_errors() {
        assert_eq!(measure(&[], FillRule::NonZero).unwrap_err(), Error::BadPath);
        assert_eq!(
            measure(&[Verb::Line(1, 1)], FillRule::NonZero).unwrap_err(),
            Error::BadPath
        );
        assert_eq!(
            measure(
                &[
                    Verb::Move(0, 0),
                    Verb::Line(1, 1),
                    Verb::Close,
                    Verb::Line(2, 2),
                ],
                FillRule::NonZero,
            )
            .unwrap_err(),
            Error::BadPath
        );
        assert_eq!(
            measure(&[Verb::Move(MAX_COORD as i32 + 1, 0)], FillRule::NonZero).unwrap_err(),
            Error::Overflow
        );

        let mut verbs = vec![Verb::Move(0, 0)];
        verbs.extend((0..MAX_VERTICES).map(|_| Verb::Line(1, 1)));
        assert_eq!(
            measure(&verbs, FillRule::NonZero).unwrap_err(),
            Error::BadPath
        );
    }

    #[test]
    fn fill_after_end_is_not_begun() {
        let mut engine = engine();
        engine.submit(Request::End).unwrap();
        let error = engine
            .submit(Request::FillPath {
                verbs: &rectangle(0, 0, 1, 1),
                rule: FillRule::NonZero,
                color: white(),
                blend: None,
            })
            .unwrap_err();
        assert_eq!(error, Error::NotBegun);
    }

    fn stroke(
        engine: &mut Engine,
        verbs: &[Verb],
        width: u32,
        align: StrokeAlign,
        join: Join,
        cap: Cap,
    ) {
        engine
            .submit(Request::StrokePath {
                verbs,
                width,
                align,
                join,
                cap,
                color: white(),
                blend: None,
            })
            .unwrap();
    }

    fn frame_bytes(engine: &mut Engine) -> Vec<u8> {
        let response = engine
            .submit(Request::ReadPixels {
                rect: Rect {
                    x1: 0,
                    y1: 0,
                    x2: 15,
                    y2: 15,
                },
                alpha: AlphaMode::Premul,
            })
            .unwrap();
        let Response::Pixels(pixels) = response else {
            panic!("expected pixels");
        };
        pixels.bytes
    }

    fn reversed_rectangle(x1: i32, y1: i32, x2: i32, y2: i32) -> [Verb; 5] {
        [
            Verb::Move(x1, y1),
            Verb::Line(x1, y2),
            Verb::Line(x2, y2),
            Verb::Line(x2, y1),
            Verb::Close,
        ]
    }

    #[test]
    fn stroke_inside_ring_is_empty_inside() {
        let mut engine = engine();
        stroke(
            &mut engine,
            &rectangle(0, 0, 10, 10),
            1,
            StrokeAlign::Inside,
            Join::Miter { limit_q8: 1024 },
            Cap::Butt,
        );
        for i in 0..10 {
            assert_eq!(pixel(&mut engine, i, 0), [255, 255, 255, 255]);
            assert_eq!(pixel(&mut engine, i, 9), [255, 255, 255, 255]);
            assert_eq!(pixel(&mut engine, 0, i), [255, 255, 255, 255]);
            assert_eq!(pixel(&mut engine, 9, i), [255, 255, 255, 255]);
        }
        assert_eq!(pixel(&mut engine, 1, 5), [0, 0, 0, 0]);
        assert_eq!(pixel(&mut engine, 5, 5), [0, 0, 0, 0]);
        assert_eq!(pixel(&mut engine, 8, 5), [0, 0, 0, 0]);
    }

    #[test]
    fn stroke_outside_band_lies_beyond_the_edge() {
        let mut engine = engine();
        stroke(
            &mut engine,
            &rectangle(1, 1, 11, 11),
            1,
            StrokeAlign::Outside,
            Join::Miter { limit_q8: 1024 },
            Cap::Butt,
        );
        assert_eq!(pixel(&mut engine, 0, 5)[3], 255);
        assert_eq!(pixel(&mut engine, 11, 5)[3], 255);
        assert_eq!(pixel(&mut engine, 5, 0)[3], 255);
        assert_eq!(pixel(&mut engine, 5, 11)[3], 255);
        assert_eq!(pixel(&mut engine, 1, 5)[3], 0);
        assert_eq!(pixel(&mut engine, 5, 10)[3], 0);
        assert_eq!(pixel(&mut engine, 5, 5)[3], 0);
    }

    #[test]
    fn stroke_square_cap_extends_but_butt_does_not() {
        let verbs = [Verb::Move(0, 0), Verb::Line(10, 0)];
        let mut square = engine();
        stroke(
            &mut square,
            &verbs,
            1,
            StrokeAlign::Outside,
            Join::Bevel,
            Cap::Square,
        );
        assert_eq!(pixel(&mut square, 9, 0), [255, 255, 255, 255]);
        assert_eq!(pixel(&mut square, 10, 0), [255, 255, 255, 255]);
        assert_eq!(pixel(&mut square, 11, 0), [0, 0, 0, 0]);

        let mut butt = engine();
        stroke(
            &mut butt,
            &verbs,
            1,
            StrokeAlign::Outside,
            Join::Bevel,
            Cap::Butt,
        );
        assert_eq!(pixel(&mut butt, 9, 0), [255, 255, 255, 255]);
        assert_eq!(pixel(&mut butt, 10, 0), [0, 0, 0, 0]);
    }

    #[test]
    fn round_arc_quarter_gives_one_split() {
        let center = PointQ8 { x: 0, y: 0 };
        let mut points = Vec::new();
        arc_into(
            &mut points,
            center,
            PointQ8 { x: 256, y: 0 },
            PointQ8 { x: 0, y: 256 },
            256,
            0,
        )
        .unwrap();
        assert_eq!(points, [PointQ8 { x: 181, y: 181 }]);
    }

    #[test]
    fn join_shapes_change_the_corner_pixel() {
        let verbs = rectangle(1, 1, 11, 11);

        let mut miter = engine();
        stroke(
            &mut miter,
            &verbs,
            1,
            StrokeAlign::Outside,
            Join::Miter { limit_q8: 1024 },
            Cap::Butt,
        );
        assert_eq!(pixel(&mut miter, 0, 0)[3], 255);
        assert_eq!(pixel(&mut miter, 0, 5)[3], 255);

        let mut bevel = engine();
        stroke(
            &mut bevel,
            &verbs,
            1,
            StrokeAlign::Outside,
            Join::Bevel,
            Cap::Butt,
        );
        assert_eq!(pixel(&mut bevel, 0, 0)[3], 128);

        let mut round = engine();
        stroke(
            &mut round,
            &verbs,
            1,
            StrokeAlign::Outside,
            Join::Round,
            Cap::Butt,
        );
        assert_eq!(pixel(&mut round, 0, 0)[3], 180);
    }

    #[test]
    fn round_cap_fills_a_quarter_disc() {
        let mut engine = engine();
        stroke(
            &mut engine,
            &[Verb::Move(0, 0), Verb::Line(10, 0)],
            1,
            StrokeAlign::Outside,
            Join::Bevel,
            Cap::Round,
        );
        assert_eq!(pixel(&mut engine, 10, 0)[3], 180);
        assert_eq!(pixel(&mut engine, 10, 1)[3], 0);
        assert_eq!(pixel(&mut engine, 9, 0)[3], 255);
    }

    #[test]
    fn miter_limit_boundary_is_inclusive() {
        let vertex = PointQ8 { x: 0, y: 0 };
        assert!(miter_fits((1024, 0), vertex, 1024, 1));
        assert!(!miter_fits((1280, 0), vertex, 1024, 1));
        assert!(miter_fits((2048, 0), vertex, 1024, 2));
        assert!(!miter_fits((2049, 0), vertex, 1024, 2));
    }

    #[test]
    fn measure_outside_stroke_includes_the_outward_band() {
        let mut engine = Engine::new();
        let response = engine
            .submit(Request::Measure {
                verbs: &rectangle(0, 0, 10, 10),
                fill: None,
                stroke: Some(Stroke {
                    width: 1,
                    align: StrokeAlign::Outside,
                    join: Join::Miter { limit_q8: 1024 },
                    cap: Cap::Butt,
                }),
            })
            .unwrap();
        let Response::Measure(rect) = response else {
            panic!("expected measure");
        };
        assert_eq!(
            rect,
            Rect {
                x1: -1,
                y1: -1,
                x2: 10,
                y2: 10
            }
        );
    }

    #[test]
    fn stroke_after_end_is_not_begun() {
        let mut engine = engine();
        engine.submit(Request::End).unwrap();
        let error = engine
            .submit(Request::StrokePath {
                verbs: &rectangle(0, 0, 10, 10),
                width: 1,
                align: StrokeAlign::Inside,
                join: Join::Miter { limit_q8: 1024 },
                cap: Cap::Butt,
                color: white(),
                blend: None,
            })
            .unwrap_err();
        assert_eq!(error, Error::NotBegun);
    }

    #[test]
    fn stroke_inside_accepts_explicitly_closed_contour() {
        let verbs = [
            Verb::Move(0, 0),
            Verb::Line(10, 0),
            Verb::Line(10, 10),
            Verb::Line(0, 0),
        ];
        let rect = measure_stroke(
            &verbs,
            &Stroke {
                width: 1,
                align: StrokeAlign::Inside,
                join: Join::Miter { limit_q8: 1024 },
                cap: Cap::Butt,
            },
        )
        .unwrap();
        assert_eq!(
            rect,
            Rect {
                x1: 0,
                y1: 0,
                x2: 9,
                y2: 9
            }
        );
    }

    #[test]
    fn stroke_inside_rejects_open_contours() {
        let open = [Verb::Move(0, 0), Verb::Line(10, 0)];
        assert_eq!(
            measure_stroke(
                &open,
                &Stroke {
                    width: 1,
                    align: StrokeAlign::Inside,
                    join: Join::Bevel,
                    cap: Cap::Butt,
                }
            )
            .unwrap_err(),
            Error::BadPath
        );

        let mut engine = engine();
        let error = engine
            .submit(Request::StrokePath {
                verbs: &open,
                width: 1,
                align: StrokeAlign::Inside,
                join: Join::Bevel,
                cap: Cap::Butt,
                color: white(),
                blend: None,
            })
            .unwrap_err();
        assert_eq!(error, Error::BadPath);
    }

    #[test]
    fn stroke_width_zero_is_bad_stroke() {
        let mut engine = engine();
        let error = engine
            .submit(Request::StrokePath {
                verbs: &rectangle(0, 0, 10, 10),
                width: 0,
                align: StrokeAlign::Outside,
                join: Join::Miter { limit_q8: 1024 },
                cap: Cap::Butt,
                color: white(),
                blend: None,
            })
            .unwrap_err();
        assert_eq!(error, Error::BadStroke);
        assert!(matches!(
            engine
                .submit(Request::FillPath {
                    verbs: &rectangle(0, 0, 1, 1),
                    rule: FillRule::NonZero,
                    color: white(),
                    blend: None,
                })
                .unwrap(),
            Response::None
        ));
    }

    #[test]
    fn diagonal_stroke_uses_coverage() {
        let mut engine = engine();
        stroke(
            &mut engine,
            &[Verb::Move(0, 0), Verb::Line(8, 8)],
            1,
            StrokeAlign::Outside,
            Join::Bevel,
            Cap::Butt,
        );
        let alpha = pixel(&mut engine, 3, 4)[3];
        assert!(alpha > 0 && alpha < 255);
        assert_eq!(pixel(&mut engine, 4, 3)[3], 0);
    }

    #[test]
    fn stroke_respects_clip() {
        let mut engine = engine();
        engine
            .submit(Request::ClipPush {
                rect: Rect {
                    x1: 0,
                    y1: 0,
                    x2: 2,
                    y2: 2,
                },
            })
            .unwrap();
        stroke(
            &mut engine,
            &rectangle(0, 0, 10, 10),
            1,
            StrokeAlign::Inside,
            Join::Miter { limit_q8: 1024 },
            Cap::Butt,
        );
        engine.submit(Request::ClipPop).unwrap();
        assert_eq!(pixel(&mut engine, 0, 0), [255, 255, 255, 255]);
        assert_eq!(pixel(&mut engine, 2, 0), [255, 255, 255, 255]);
        assert_eq!(pixel(&mut engine, 0, 2), [255, 255, 255, 255]);
        assert_eq!(pixel(&mut engine, 1, 1), [0, 0, 0, 0]);
        assert_eq!(pixel(&mut engine, 5, 0), [0, 0, 0, 0]);
    }

    #[test]
    fn stroke_reversed_winding_keeps_sides() {
        let verbs = reversed_rectangle(2, 2, 12, 12);

        let mut inside = engine();
        stroke(
            &mut inside,
            &verbs,
            1,
            StrokeAlign::Inside,
            Join::Miter { limit_q8: 1024 },
            Cap::Butt,
        );
        assert_eq!(pixel(&mut inside, 2, 5)[3], 255);
        assert_eq!(pixel(&mut inside, 11, 5)[3], 255);
        assert_eq!(pixel(&mut inside, 5, 2)[3], 255);
        assert_eq!(pixel(&mut inside, 5, 11)[3], 255);
        assert_eq!(pixel(&mut inside, 5, 5)[3], 0);
        assert_eq!(pixel(&mut inside, 1, 5)[3], 0);

        let mut outside = engine();
        stroke(
            &mut outside,
            &verbs,
            1,
            StrokeAlign::Outside,
            Join::Miter { limit_q8: 1024 },
            Cap::Butt,
        );
        assert_eq!(pixel(&mut outside, 1, 5)[3], 255);
        assert_eq!(pixel(&mut outside, 12, 5)[3], 255);
        assert_eq!(pixel(&mut outside, 5, 1)[3], 255);
        assert_eq!(pixel(&mut outside, 5, 12)[3], 255);
        assert_eq!(pixel(&mut outside, 2, 5)[3], 0);
        assert_eq!(pixel(&mut outside, 5, 5)[3], 0);
    }

    #[test]
    fn miter_over_limit_falls_back_to_bevel() {
        let verbs = [Verb::Move(0, 10), Verb::Line(10, 10), Verb::Line(0, 11)];
        let mut miter = engine();
        stroke(
            &mut miter,
            &verbs,
            1,
            StrokeAlign::Outside,
            Join::Miter { limit_q8: 1024 },
            Cap::Butt,
        );
        let miter_frame = frame_bytes(&mut miter);

        let mut bevel = engine();
        stroke(
            &mut bevel,
            &verbs,
            1,
            StrokeAlign::Outside,
            Join::Bevel,
            Cap::Butt,
        );
        let bevel_frame = frame_bytes(&mut bevel);

        assert_eq!(miter_frame, bevel_frame);
        assert_eq!(pixel(&mut miter, 5, 10)[3], 255);
    }

    #[test]
    fn half_turn_round_join_fills_the_outside_half_disc() {
        let mut engine = engine();
        stroke(
            &mut engine,
            &[Verb::Move(0, 5), Verb::Line(10, 5), Verb::Line(5, 5)],
            1,
            StrokeAlign::Outside,
            Join::Round,
            Cap::Butt,
        );
        assert_eq!(pixel(&mut engine, 10, 5)[3], 180);
        assert_eq!(pixel(&mut engine, 10, 4)[3], 180);
        assert_eq!(pixel(&mut engine, 9, 5)[3], 255);
        assert_eq!(pixel(&mut engine, 9, 4)[3], 255);
        assert_eq!(pixel(&mut engine, 11, 5)[3], 0);
    }

    #[test]
    fn measure_stroke_includes_miter_arc_and_square() {
        let v = [Verb::Move(0, 0), Verb::Line(10, 10), Verb::Line(20, 0)];
        let measure_with = |join: Join, width: u32| {
            measure_stroke(
                &v,
                &Stroke {
                    width,
                    align: StrokeAlign::Outside,
                    join,
                    cap: Cap::Butt,
                },
            )
            .unwrap()
        };

        let miter = measure_with(Join::Miter { limit_q8: 1024 }, 1);
        assert_eq!(
            miter,
            Rect {
                x1: -1,
                y1: 0,
                x2: 20,
                y2: 11
            }
        );
        let bevel = measure_with(Join::Bevel, 1);
        assert_eq!(
            bevel,
            Rect {
                x1: -1,
                y1: 0,
                x2: 20,
                y2: 10
            }
        );
        let round = measure_with(Join::Round, 4);
        assert_eq!(
            round,
            Rect {
                x1: -3,
                y1: 0,
                x2: 22,
                y2: 13
            }
        );
        let bevel_wide = measure_with(Join::Bevel, 4);
        assert_eq!(
            bevel_wide,
            Rect {
                x1: -3,
                y1: 0,
                x2: 22,
                y2: 12
            }
        );

        let line = [Verb::Move(0, 5), Verb::Line(10, 5)];
        let butt = measure_stroke(
            &line,
            &Stroke {
                width: 1,
                align: StrokeAlign::Outside,
                join: Join::Bevel,
                cap: Cap::Butt,
            },
        )
        .unwrap();
        assert_eq!(
            butt,
            Rect {
                x1: 0,
                y1: 5,
                x2: 9,
                y2: 5
            }
        );
        let square = measure_stroke(
            &line,
            &Stroke {
                width: 1,
                align: StrokeAlign::Outside,
                join: Join::Bevel,
                cap: Cap::Square,
            },
        )
        .unwrap();
        assert_eq!(
            square,
            Rect {
                x1: -1,
                y1: 5,
                x2: 10,
                y2: 5
            }
        );
    }

    #[test]
    fn stroke_start_cap_is_drawn() {
        let verbs = [Verb::Move(5, 5), Verb::Line(10, 5)];

        let mut square = engine();
        stroke(
            &mut square,
            &verbs,
            1,
            StrokeAlign::Outside,
            Join::Bevel,
            Cap::Square,
        );
        assert_eq!(pixel(&mut square, 4, 5)[3], 255);
        assert_eq!(pixel(&mut square, 10, 5)[3], 255);
        assert_eq!(pixel(&mut square, 11, 5)[3], 0);

        let mut butt = engine();
        stroke(
            &mut butt,
            &verbs,
            1,
            StrokeAlign::Outside,
            Join::Bevel,
            Cap::Butt,
        );
        assert_eq!(pixel(&mut butt, 4, 5)[3], 0);
        assert_eq!(pixel(&mut butt, 9, 5)[3], 255);
        assert_eq!(pixel(&mut butt, 10, 5)[3], 0);

        let mut round = engine();
        stroke(
            &mut round,
            &verbs,
            1,
            StrokeAlign::Outside,
            Join::Bevel,
            Cap::Round,
        );
        assert_eq!(pixel(&mut round, 4, 5)[3], 180);
        assert_eq!(pixel(&mut round, 10, 5)[3], 180);
    }
}
