//! Интра-предикторы (нормативные): DC, TM, PLANAR, V, H, D45, D135.
//!
//! Опорные отсчёты берутся из уже реконструированных пикселей плоскости.
//! Недоступные опоры заменяются: сверху/слева за кадром — константой 128,
//! неготовые выше-справа — репликацией последнего доступного (см. `preceded`).

use crate::frame::Plane;

pub const MODE_DC: u8 = 0;
pub const MODE_TM: u8 = 1;
pub const MODE_PLANAR: u8 = 2;
pub const MODE_V: u8 = 3;
pub const MODE_H: u8 = 4;
pub const MODE_D45: u8 = 5;
pub const MODE_D135: u8 = 6;
pub const NUM_MODES: usize = 7;

/// Направленные режимы (V/H/D45/D135) — контекст соседей и группировка синтаксиса.
#[inline]
pub fn is_directional(mode: u8) -> bool {
    (MODE_V..=MODE_D135).contains(&mode)
}

/// Параметры сетки доступности опор: люма — SB 64 / ячейка 8, хрома — 32 / 4.
#[derive(Debug, Clone, Copy)]
pub struct RefGrid {
    pub sb: usize,
    pub cell: usize,
}

pub const LUMA_GRID: RefGrid = RefGrid { sb: 64, cell: 8 };
pub const CHROMA_GRID: RefGrid = RefGrid { sb: 32, cell: 4 };

/// Morton-индекс ячейки внутри суперблока (порядок кодирования quadtree:
/// TL, TR, BL, BR — y-бит старше x-бита на каждом уровне).
#[inline]
fn morton(cx: usize, cy: usize) -> u32 {
    let mut m = 0u32;
    for bit in 0..3 {
        m |= (((cx >> bit) & 1) as u32) << (2 * bit);
        m |= (((cy >> bit) & 1) as u32) << (2 * bit + 1);
    }
    m
}

/// Нормативно: реконструирован ли пиксель (px, py) к моменту кодирования блока
/// с началом (bx, by). Требование: py < by (строка выше блока).
#[inline]
fn preceded(px: usize, py: usize, bx: usize, by: usize, g: RefGrid) -> bool {
    if py / g.sb < by / g.sb {
        // Предыдущий ряд суперблоков закодирован целиком.
        return true;
    }
    if px / g.sb != bx / g.sb {
        // Суперблок справа в том же ряду ещё не кодировался.
        return false;
    }
    let (cx, cy) = ((px % g.sb) / g.cell, (py % g.sb) / g.cell);
    let (bcx, bcy) = ((bx % g.sb) / g.cell, (by % g.sb) / g.cell);
    morton(cx, cy) < morton(bcx, bcy)
}

/// Опоры блока n×n в позиции (x, y): above[2n] (с продолжением вправо), left[n].
pub struct Refs {
    pub above: [u8; 128],
    pub left: [u8; 64],
    pub above_left: u8,
    pub has_above: bool,
    pub has_left: bool,
}

impl Refs {
    pub fn gather(plane: &Plane, x: usize, y: usize, n: usize, g: RefGrid) -> Refs {
        let mut r = Refs {
            above: [128; 128],
            left: [128; 64],
            above_left: 128,
            has_above: y > 0,
            has_left: x > 0,
        };
        if r.has_above {
            let row = plane.row(y - 1);
            r.above[..n].copy_from_slice(&row[x..x + n]);
            // Выше-справа: реконструированные — как есть, дальше — репликация последнего.
            let mut last = r.above[n - 1];
            for k in n..2 * n {
                let px = x + k;
                if px < plane.width() && preceded(px, y - 1, x, y, g) {
                    last = row[px];
                }
                r.above[k] = last;
            }
        }
        if r.has_left {
            for i in 0..n {
                r.left[i] = plane.get(x - 1, y + i);
            }
        }
        if r.has_above && r.has_left {
            r.above_left = plane.get(x - 1, y - 1);
        }
        r
    }
}

#[inline]
fn avg3(a: u8, b: u8, c: u8) -> u8 {
    ((u16::from(a) + 2 * u16::from(b) + u16::from(c) + 2) >> 2) as u8
}

/// Предсказание блока n×n в `pred` (raster, длина n²).
pub fn predict(mode: u8, refs: &Refs, n: usize, pred: &mut [i32]) {
    match mode {
        MODE_DC => {
            let sum_above: u32 = refs.above[..n].iter().map(|&v| u32::from(v)).sum();
            let sum_left: u32 = refs.left[..n].iter().map(|&v| u32::from(v)).sum();
            let dc = match (refs.has_above, refs.has_left) {
                (true, true) => (sum_above + sum_left + n as u32) / (2 * n as u32),
                (true, false) => (sum_above + n as u32 / 2) / n as u32,
                (false, true) => (sum_left + n as u32 / 2) / n as u32,
                (false, false) => 128,
            } as i32;
            pred[..n * n].fill(dc);
        }
        MODE_TM => {
            // p[i][j] = clamp(left[i] + above[j] - above_left)
            let al = i32::from(refs.above_left);
            for i in 0..n {
                let l = i32::from(refs.left[i]);
                for j in 0..n {
                    pred[i * n + j] = (l + i32::from(refs.above[j]) - al).clamp(0, 255);
                }
            }
        }
        MODE_PLANAR => {
            // Билинейная интерполяция к углам TR (above[n]) и BL (left[n-1]).
            let shift = n.trailing_zeros() + 1;
            let tr = i32::from(refs.above[n]);
            let bl = i32::from(refs.left[n - 1]);
            let nn = n as i32;
            for i in 0..n {
                let l = i32::from(refs.left[i]);
                let iv = i as i32;
                for j in 0..n {
                    let a = i32::from(refs.above[j]);
                    let jv = j as i32;
                    let hor = (nn - 1 - jv) * l + (jv + 1) * tr;
                    let ver = (nn - 1 - iv) * a + (iv + 1) * bl;
                    pred[i * n + j] = (hor + ver + nn) >> shift;
                }
            }
        }
        MODE_V => {
            for i in 0..n {
                for j in 0..n {
                    pred[i * n + j] = i32::from(refs.above[j]);
                }
            }
        }
        MODE_H => {
            for i in 0..n {
                let l = i32::from(refs.left[i]);
                pred[i * n..(i + 1) * n].fill(l);
            }
        }
        MODE_D45 => {
            // Диагональ вниз-влево: сглаженная верхняя опора длиной 2n.
            for i in 0..n {
                for j in 0..n {
                    let k = i + j;
                    pred[i * n + j] = if k + 2 < 2 * n {
                        i32::from(avg3(refs.above[k], refs.above[k + 1], refs.above[k + 2]))
                    } else {
                        i32::from(refs.above[2 * n - 1])
                    };
                }
            }
        }
        _ => {
            // D135, диагональ вниз-вправо: сглаженная кромка от нижней-левой
            // опоры через угол к верхней-правой (по libvpx d135).
            let mut border = [0u8; 127]; // 2n-1 отсчётов
            for (i, b) in border.iter_mut().enumerate().take(n - 2) {
                *b = avg3(
                    refs.left[n - 3 - i],
                    refs.left[n - 2 - i],
                    refs.left[n - 1 - i],
                );
            }
            border[n - 2] = avg3(
                refs.above_left,
                refs.left[0],
                if n > 1 { refs.left[1] } else { refs.left[0] },
            );
            border[n - 1] = avg3(refs.left[0], refs.above_left, refs.above[0]);
            border[n] = avg3(refs.above_left, refs.above[0], refs.above[1]);
            for i in 0..n - 2 {
                border[n + 1 + i] = avg3(refs.above[i], refs.above[i + 1], refs.above[i + 2]);
            }
            for i in 0..n {
                for j in 0..n {
                    pred[i * n + j] = i32::from(border[n - 1 - i + j]);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dc_without_refs_is_128() {
        let plane = Plane::new(16, 16);
        let refs = Refs::gather(&plane, 0, 0, 8, LUMA_GRID);
        let mut pred = [0i32; 64];
        predict(MODE_DC, &refs, 8, &mut pred);
        assert!(pred.iter().all(|&p| p == 128));
    }

    #[test]
    fn v_copies_above_row() {
        let mut plane = Plane::new(16, 16);
        for j in 0..16 {
            plane.set(j, 3, (j * 10) as u8);
        }
        let refs = Refs::gather(&plane, 8, 4, 8, LUMA_GRID);
        let mut pred = [0i32; 64];
        predict(MODE_V, &refs, 8, &mut pred);
        for i in 0..8 {
            for j in 0..8 {
                assert_eq!(pred[i * 8 + j], ((8 + j) * 10) as i32);
            }
        }
    }

    #[test]
    fn tm_degrades_to_h_without_above() {
        let mut plane = Plane::new(16, 16);
        for i in 0..16 {
            plane.set(7, i, (40 + i) as u8);
        }
        let refs = Refs::gather(&plane, 8, 0, 8, LUMA_GRID);
        let mut pred = [0i32; 64];
        predict(MODE_TM, &refs, 8, &mut pred);
        // above=128, al=128 → pred = left[i]
        for i in 0..8 {
            for j in 0..8 {
                assert_eq!(pred[i * 8 + j], 40 + i as i32);
            }
        }
    }

    #[test]
    fn planar_flat_refs_give_flat_prediction() {
        let mut plane = Plane::new(32, 32);
        plane.data_mut().fill(77);
        let refs = Refs::gather(&plane, 8, 8, 8, LUMA_GRID);
        let mut pred = [0i32; 64];
        predict(MODE_PLANAR, &refs, 8, &mut pred);
        assert!(pred.iter().all(|&p| p == 77), "{pred:?}");
    }

    #[test]
    fn d45_projects_diagonally() {
        let mut plane = Plane::new(32, 32);
        // Верхняя строка: рампа, чтобы диагональ была видна.
        for j in 0..32 {
            plane.set(j, 7, (j * 8).min(255) as u8);
        }
        let refs = Refs::gather(&plane, 0, 8, 8, LUMA_GRID);
        let mut pred = [0i32; 64];
        predict(MODE_D45, &refs, 8, &mut pred);
        // pred[i][j] зависит только от i+j и растёт вдоль диагонали.
        for i in 1..8 {
            for j in 1..8 {
                assert_eq!(
                    pred[i * 8 + j],
                    pred[(i - 1) * 8 + j + 1].max(pred[i * 8 + j])
                );
            }
        }
    }

    /// Z-порядок: выше-справа доступно из предыдущего SB-ряда, недоступно
    /// из ещё не закодированных соседей.
    #[test]
    fn above_right_availability() {
        // Блок в начале SB-ряда: над ним всё закодировано.
        assert!(preceded(70, 63, 0, 64, LUMA_GRID));
        // Тот же ряд SB: правый сосед-SB ещё не кодировался.
        assert!(!preceded(64, 7, 56, 8, LUMA_GRID));
        // Внутри SB: ячейка (2,0) кодируется после (1,1) (z-порядок).
        assert!(!preceded(16, 7, 8, 8, LUMA_GRID));
        // Внутри SB: ячейка (1,0) кодируется до (1,1).
        assert!(preceded(12, 7, 8, 8, LUMA_GRID));
    }
}
