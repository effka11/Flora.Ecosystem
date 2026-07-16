//! Tile-local directional constrained post-filter (FRC-I v7.5).
//!
//! The filter is outside the prediction/CfL loop. Direction is derived for
//! every 8×8 block from the unmodified input plane; all taps read the same
//! immutable source so traversal order cannot change the result.

use crate::deblock::deblock_plane;

pub const N_STRENGTHS: u8 = 4;

// For each direction: first and second primary tap offsets.
const DIRECTIONS: [[(isize, isize); 2]; 8] = [
    [(1, -1), (2, -2)],
    [(1, 0), (2, -1)],
    [(1, 0), (2, 0)],
    [(1, 0), (2, 1)],
    [(1, 1), (2, 2)],
    [(0, 1), (1, 2)],
    [(0, 1), (0, 2)],
    [(0, 1), (-1, 2)],
];

#[inline]
fn strength_params(strength: u8) -> (i32, i32, u32) {
    match strength {
        1 => (2, 1, 3),
        2 => (6, 2, 3),
        3 => (12, 4, 4),
        _ => (0, 0, 0),
    }
}

#[inline]
fn constrain(diff: i32, strength: i32, damping: u32) -> i32 {
    if strength == 0 {
        return 0;
    }
    let magnitude = diff.unsigned_abs();
    let strength_log2 = 31 - (strength as u32).leading_zeros();
    let shift = damping.saturating_sub(strength_log2);
    let magnitude_limit = strength.saturating_sub((magnitude >> shift) as i32).max(0);
    diff.signum() * (magnitude as i32).min(magnitude_limit)
}

struct PlaneRef<'a> {
    samples: &'a [i16],
    w: usize,
    h: usize,
}

struct FilterAccumulator {
    sum: i32,
    minimum: i32,
    maximum: i32,
}

impl PlaneRef<'_> {
    #[inline]
    fn sample(&self, x: isize, y: isize) -> i32 {
        let sx = x.clamp(0, self.w.saturating_sub(1) as isize) as usize;
        let sy = y.clamp(0, self.h.saturating_sub(1) as isize) as usize;
        i32::from(self.samples[sy * self.w + sx])
    }

    #[inline]
    fn accumulate_direction(
        &self,
        position: (usize, usize),
        direction: usize,
        taps: [i32; 2],
        strength: i32,
        damping: u32,
        accumulator: &mut FilterAccumulator,
    ) {
        let (x, y) = position;
        let center = i32::from(self.samples[y * self.w + x]);
        for (tap, &(dx, dy)) in DIRECTIONS[direction].iter().enumerate() {
            for sign in [-1isize, 1] {
                let value = self.sample(x as isize + sign * dx, y as isize + sign * dy);
                accumulator.minimum = accumulator.minimum.min(value);
                accumulator.maximum = accumulator.maximum.max(value);
                accumulator.sum += taps[tap] * constrain(value - center, strength, damping);
            }
        }
    }
}

fn find_direction(
    src: &[i16],
    w: usize,
    x0: usize,
    y0: usize,
    block_w: usize,
    block_h: usize,
) -> usize {
    let mut best_direction = 0usize;
    let mut best_score = u64::MAX;
    for (direction, offsets) in DIRECTIONS.iter().enumerate() {
        let mut cost = 0u64;
        let mut weight = 0u64;
        for y in 0..block_h {
            for x in 0..block_w {
                let center = i32::from(src[(y0 + y) * w + x0 + x]);
                for (tap, &(dx, dy)) in offsets.iter().enumerate() {
                    let nx = x as isize + dx;
                    let ny = y as isize + dy;
                    if nx < 0 || ny < 0 || nx >= block_w as isize || ny >= block_h as isize {
                        continue;
                    }
                    let neighbor = i32::from(src[(y0 + ny as usize) * w + x0 + nx as usize]);
                    let tap_weight = if tap == 0 { 2 } else { 1 };
                    cost += u64::from(center.abs_diff(neighbor)) * tap_weight;
                    weight += tap_weight;
                }
            }
        }
        if weight == 0 {
            continue;
        }
        let score = (cost << 10) / weight;
        if score < best_score {
            best_score = score;
            best_direction = direction;
        }
    }
    best_direction
}

#[inline]
fn filter_sample(
    src: &[i16],
    w: usize,
    h: usize,
    x: usize,
    y: usize,
    direction: usize,
    strength: u8,
) -> i16 {
    let (primary_strength, secondary_strength, damping) = strength_params(strength);
    let plane = PlaneRef { samples: src, w, h };
    let center = i32::from(src[y * w + x]);
    let mut accumulator = FilterAccumulator {
        sum: 0,
        minimum: center,
        maximum: center,
    };
    plane.accumulate_direction(
        (x, y),
        direction,
        [4, 2],
        primary_strength,
        damping,
        &mut accumulator,
    );
    for secondary in [(direction + 2) & 7, (direction + 6) & 7] {
        plane.accumulate_direction(
            (x, y),
            secondary,
            [2, 1],
            secondary_strength,
            damping,
            &mut accumulator,
        );
    }
    let adjustment = (accumulator.sum + 8 - i32::from(accumulator.sum < 0)) >> 4;
    (center + adjustment)
        .clamp(accumulator.minimum, accumulator.maximum)
        .clamp(0, 255) as i16
}

/// Applies a signalled strength in-place. Strength zero is an exact no-op.
pub fn filter_plane(buf: &mut [i16], w: usize, h: usize, strength: u8) {
    debug_assert_eq!(buf.len(), w * h);
    debug_assert!(strength < N_STRENGTHS);
    if strength == 0 || w == 0 || h == 0 {
        return;
    }
    let src = buf.to_vec();
    for y0 in (0..h).step_by(8) {
        for x0 in (0..w).step_by(8) {
            let block_w = (w - x0).min(8);
            let block_h = (h - y0).min(8);
            let direction = find_direction(&src, w, x0, y0, block_w, block_h);
            for y in y0..y0 + block_h {
                for x in x0..x0 + block_w {
                    buf[y * w + x] = filter_sample(&src, w, h, x, y, direction, strength);
                }
            }
        }
    }
}

#[inline]
fn squared_error(reference: i16, candidate: i16) -> u64 {
    let difference = i64::from(reference) - i64::from(candidate);
    (difference * difference) as u64
}

#[inline]
fn suggested_strength(dc_step: u16) -> u8 {
    match dc_step {
        0..=6 => 1,
        7..=16 => 2,
        _ => 3,
    }
}

/// Encoder-only off/on decision for the qstep-derived strength.
pub fn choose_strength(
    original: &[i16],
    reconstructed: &[i16],
    w: usize,
    h: usize,
    dc_step: u16,
    deblock: bool,
) -> u8 {
    debug_assert_eq!(original.len(), w * h);
    debug_assert_eq!(reconstructed.len(), w * h);
    let mut baseline = reconstructed.to_vec();
    if deblock {
        deblock_plane(&mut baseline, w, h, dc_step);
    }
    let strength = suggested_strength(dc_step);
    let block_cols = w.div_ceil(8);
    let block_rows = h.div_ceil(8);
    let block_step = if block_cols >= 4 && block_rows >= 4 {
        2
    } else {
        1
    };
    let mut baseline_sse = 0u64;
    let mut filtered_sse = 0u64;
    for block_y in (0..block_rows).step_by(block_step) {
        for block_x in (0..block_cols).step_by(block_step) {
            let x0 = block_x * 8;
            let y0 = block_y * 8;
            let block_w = (w - x0).min(8);
            let block_h = (h - y0).min(8);
            let direction = find_direction(&baseline, w, x0, y0, block_w, block_h);
            for y in y0..y0 + block_h {
                for x in x0..x0 + block_w {
                    let index = y * w + x;
                    baseline_sse += squared_error(original[index], baseline[index]);
                    filtered_sse += squared_error(
                        original[index],
                        filter_sample(&baseline, w, h, x, y, direction, strength),
                    );
                }
            }
        }
    }
    if filtered_sse < baseline_sse {
        strength
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_and_disabled_planes_are_unchanged() {
        let flat = vec![128i16; 17 * 13];
        for strength in 0..N_STRENGTHS {
            let mut filtered = flat.clone();
            filter_plane(&mut filtered, 17, 13, strength);
            assert_eq!(filtered, flat);
        }
    }

    #[test]
    fn direction_follows_coherent_lines() {
        let (w, h) = (8usize, 8usize);
        let horizontal: Vec<i16> = (0..w * h).map(|i| ((i / w) * 20) as i16).collect();
        let vertical: Vec<i16> = (0..w * h).map(|i| ((i % w) * 20) as i16).collect();
        assert_eq!(find_direction(&horizontal, w, 0, 0, w, h), 2);
        assert_eq!(find_direction(&vertical, w, 0, 0, w, h), 6);
    }

    #[test]
    fn contrast_edge_does_not_overshoot() {
        let (w, h) = (16usize, 9usize);
        let original: Vec<i16> = (0..w * h)
            .map(|i| if i % w < 8 { 16 } else { 240 })
            .collect();
        for strength in 1..N_STRENGTHS {
            let mut filtered = original.clone();
            filter_plane(&mut filtered, w, h, strength);
            assert!(filtered.iter().all(|&sample| (16..=240).contains(&sample)));
        }
    }

    #[test]
    fn filter_is_transpose_symmetric() {
        let size = 16usize;
        let original: Vec<i16> = (0..size * size)
            .map(|i| {
                let x = i % size;
                let y = i / size;
                ((17 * x + 9 * y + 3 * x * y) & 255) as i16
            })
            .collect();
        let mut transposed = vec![0i16; original.len()];
        for y in 0..size {
            for x in 0..size {
                transposed[x * size + y] = original[y * size + x];
            }
        }
        let mut filtered = original;
        filter_plane(&mut filtered, size, size, 2);
        filter_plane(&mut transposed, size, size, 2);
        for y in 0..size {
            for x in 0..size {
                assert_eq!(filtered[y * size + x], transposed[x * size + y]);
            }
        }
    }

    #[test]
    fn encoder_gate_accepts_helpful_filter_and_rejects_tie() {
        let (w, h) = (32usize, 32usize);
        let original = vec![128i16; w * h];
        assert_eq!(choose_strength(&original, &original, w, h, 10, false), 0);

        let ringing: Vec<i16> = (0..w * h)
            .map(|i| if i % w % 2 == 0 { 126 } else { 130 })
            .collect();
        assert_eq!(choose_strength(&original, &ringing, w, h, 10, false), 2);
    }

    #[test]
    fn small_planes_do_not_panic() {
        for (w, h) in [(1usize, 1usize), (2, 7), (7, 2), (9, 9), (17, 3)] {
            let mut plane = vec![100i16; w * h];
            filter_plane(&mut plane, w, h, 3);
        }
    }
}
