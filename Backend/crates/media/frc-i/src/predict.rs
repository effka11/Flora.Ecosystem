//! Предсказание для lossless-режима (FRC-I.md §5): MED-предиктор (LOCO-I / JPEG-LS)
//! и контексты по локальной активности градиентов.

/// Число контекстов lossless-плоскости.
pub const N_CTX_LOSSLESS: usize = 8;

/// MED (Median Edge Detector): выбирает min/max соседей у горизонтальных и
/// вертикальных границ, иначе — планарную экстраполяцию `W + N - NW`.
#[inline]
pub fn med(w: i32, n: i32, nw: i32) -> i32 {
    let (mn, mx) = if w <= n { (w, n) } else { (n, w) };
    if nw >= mx {
        mn
    } else if nw <= mn {
        mx
    } else {
        w + n - nw
    }
}

/// Контекст 0..=7 по суммарной активности градиентов `|N-NW| + |NW-W|`.
///
/// Гладкие области получают контекст 0..2 (узкие распределения остатков),
/// текстуры и границы — старшие контексты. Пороги — степени двойки.
#[inline]
pub fn grad_context(w: i32, n: i32, nw: i32) -> usize {
    let g = (n - nw).abs() + (nw - w).abs();
    match g {
        0 => 0,
        1 => 1,
        2 => 2,
        3..=4 => 3,
        5..=8 => 4,
        9..=16 => 5,
        17..=32 => 6,
        _ => 7,
    }
}

/// Соседи текущего пикселя с виртуальными значениями за границей.
///
/// `row` — текущая строка (заполнена до `x`), `prev` — предыдущая строка
/// (или `None` для первой), `mid` — значение виртуального соседа.
#[inline]
pub fn neighbors(row: &[i16], prev: Option<&[i16]>, x: usize, mid: i32) -> (i32, i32, i32) {
    match (x, prev) {
        (0, None) => (mid, mid, mid),
        (0, Some(p)) => {
            let n = i32::from(p[0]);
            (n, n, n)
        }
        (_, None) => {
            let w = i32::from(row[x - 1]);
            (w, w, w)
        }
        (_, Some(p)) => (i32::from(row[x - 1]), i32::from(p[x]), i32::from(p[x - 1])),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn med_edges() {
        // Вертикальная граница: NW == N > W — предсказываем W.
        assert_eq!(med(10, 200, 200), 10);
        // Горизонтальная граница: NW == W < N — предсказываем N.
        assert_eq!(med(10, 200, 10), 200);
        // Плавный градиент: планарная экстраполяция.
        assert_eq!(med(100, 110, 105), 105);
    }

    #[test]
    fn contexts_cover_range() {
        assert_eq!(grad_context(0, 0, 0), 0);
        assert_eq!(grad_context(0, 1, 0), 1);
        assert_eq!(grad_context(0, 255, -255), 7);
    }
}
