//! Зигзаг-сканы коэффициентов и полосы (bands) для контекстов энтропийного кодера.

use std::sync::OnceLock;

/// Полосная карта нормированной позиции скана (pos·64/n²) → полоса 0..7.
const BAND64: [u8; 64] = {
    let mut b = [7u8; 64];
    let mut i = 0;
    while i < 64 {
        b[i] = match i {
            0 => 0,
            1 => 1,
            2 => 2,
            3..=5 => 3,
            6..=9 => 4,
            10..=20 => 5,
            21..=41 => 6,
            _ => 7,
        };
        i += 1;
    }
    b
};

pub const NUM_BANDS: usize = 8;

#[inline]
pub fn band(scan_pos: usize, n2: usize) -> usize {
    BAND64[scan_pos * 64 / n2] as usize
}

fn zigzag(n: usize) -> Vec<u16> {
    let mut order = Vec::with_capacity(n * n);
    for d in 0..(2 * n - 1) {
        if d % 2 == 0 {
            // чётная диагональ: снизу-слева вверх-вправо
            let r_start = d.min(n - 1);
            let r_end = d.saturating_sub(n - 1);
            let mut r = r_start as isize;
            while r >= r_end as isize {
                let c = d - r as usize;
                order.push((r as usize * n + c) as u16);
                r -= 1;
            }
        } else {
            let r_start = d.saturating_sub(n - 1);
            let r_end = d.min(n - 1);
            for r in r_start..=r_end {
                let c = d - r;
                order.push((r * n + c) as u16);
            }
        }
    }
    order
}

pub struct Scans {
    s4: Vec<u16>,
    s8: Vec<u16>,
    s16: Vec<u16>,
    s32: Vec<u16>,
}

impl Scans {
    #[inline]
    pub fn get(&self, n: usize) -> &[u16] {
        match n {
            4 => &self.s4,
            8 => &self.s8,
            16 => &self.s16,
            _ => &self.s32,
        }
    }
}

/// Глобальные сканы (детерминированная генерация).
pub fn scans() -> &'static Scans {
    static SCANS: OnceLock<Scans> = OnceLock::new();
    SCANS.get_or_init(|| Scans {
        s4: zigzag(4),
        s8: zigzag(8),
        s16: zigzag(16),
        s32: zigzag(32),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zigzag8_matches_jpeg_prefix() {
        let z = zigzag(8);
        assert_eq!(&z[..10], &[0, 1, 8, 16, 9, 2, 3, 10, 17, 24]);
        assert_eq!(z.len(), 64);
    }

    #[test]
    fn zigzag_is_permutation() {
        for &n in &[4usize, 8, 16, 32] {
            let z = zigzag(n);
            let mut seen = vec![false; n * n];
            for &p in &z {
                assert!(!seen[p as usize]);
                seen[p as usize] = true;
            }
            assert!(seen.iter().all(|&s| s));
        }
    }

    #[test]
    fn bands_monotonic_start() {
        assert_eq!(band(0, 64), 0);
        assert_eq!(band(1, 64), 1);
        assert_eq!(band(63, 64), 7);
        assert_eq!(band(0, 16), 0);
        assert_eq!(band(15, 16), 7);
    }
}
