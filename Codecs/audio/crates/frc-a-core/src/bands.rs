//! Нормативная сетка полос (шкала Барка) для N=960 @ 48 кГц — FRC-A.md, «Полосы».

pub const NUM_BANDS: usize = 21;

/// Края полос в бинах MDCT; полоса `b` покрывает `[EDGES[b], EDGES[b+1])`.
pub const BAND_EDGES: [usize; NUM_BANDS + 1] = [
    0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 272, 320, 384, 480, 624, 800,
];

/// Кодируются бины `[0, CODED_BINS)`; выше (20–24 кГц) — нули в v0.
pub const CODED_BINS: usize = 800;

pub fn band_range(b: usize) -> core::ops::Range<usize> {
    BAND_EDGES[b]..BAND_EDGES[b + 1]
}

pub fn band_width(b: usize) -> usize {
    BAND_EDGES[b + 1] - BAND_EDGES[b]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edges_are_consistent() {
        assert_eq!(BAND_EDGES[0], 0);
        assert_eq!(BAND_EDGES[NUM_BANDS], CODED_BINS);
        for b in 0..NUM_BANDS {
            assert!(band_width(b) > 0);
        }
    }
}
