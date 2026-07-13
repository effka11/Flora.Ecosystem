//! Деблокинг-фильтр (нормативный): сглаживает границы 8×8-сетки.
//!
//! Применяется к полностью реконструированному кадру перед выводом.
//! Интра-предсказание использует НЕфильтрованную реконструкцию — фильтр
//! не участвует в цикле предсказания v0.1 (intra-only).

use crate::frame::{Frame, Plane};
use crate::quant::ac_step;

/// Порог силы фильтра из qp (нормативная формула).
#[inline]
pub fn filter_limit(qp: u8) -> i32 {
    (ac_step(qp) / 4).clamp(2, 120)
}

#[inline]
fn filter_pair(p1: u8, p0: u8, q0: u8, q1: u8, limit: i32) -> (u8, u8) {
    let (p1, p0, q0, q1) = (i32::from(p1), i32::from(p0), i32::from(q0), i32::from(q1));
    if 2 * (p0 - q0).abs() + (p1 - q1).abs() / 2 > limit {
        return (p0 as u8, q0 as u8);
    }
    let a = ((p1 - q1).clamp(-128, 127) + 3 * (q0 - p0)).clamp(-128, 127);
    let f1 = (a + 4).clamp(-128, 127) >> 3;
    let f2 = (a + 3).clamp(-128, 127) >> 3;
    let new_q0 = (q0 - f1).clamp(0, 255) as u8;
    let new_p0 = (p0 + f2).clamp(0, 255) as u8;
    (new_p0, new_q0)
}

fn filter_plane(plane: &mut Plane, limit: i32) {
    let (w, h) = (plane.width(), plane.height());
    // Вертикальные границы (столбцы x = 8, 16, ...).
    for x in (8..w).step_by(8) {
        for y in 0..h {
            let p1 = plane.get(x - 2, y);
            let p0 = plane.get(x - 1, y);
            let q0 = plane.get(x, y);
            let q1 = plane.get(x + 1, y);
            let (np0, nq0) = filter_pair(p1, p0, q0, q1, limit);
            plane.set(x - 1, y, np0);
            plane.set(x, y, nq0);
        }
    }
    // Горизонтальные границы (строки y = 8, 16, ...).
    for y in (8..h).step_by(8) {
        for x in 0..w {
            let p1 = plane.get(x, y - 2);
            let p0 = plane.get(x, y - 1);
            let q0 = plane.get(x, y);
            let q1 = plane.get(x, y + 1);
            let (np0, nq0) = filter_pair(p1, p0, q0, q1, limit);
            plane.set(x, y - 1, np0);
            plane.set(x, y, nq0);
        }
    }
}

/// Фильтрует кадр на месте.
pub fn loop_filter(frame: &mut Frame, qp: u8) {
    let limit = filter_limit(qp);
    filter_plane(&mut frame.y, limit);
    filter_plane(&mut frame.cb, limit);
    filter_plane(&mut frame.cr, limit);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smooths_step_edge() {
        let (p0, q0) = (100u8, 116u8);
        let (np0, nq0) = filter_pair(100, p0, q0, 116, filter_limit(40));
        assert!(np0 > p0 && nq0 < q0, "{np0} {nq0}");
    }

    #[test]
    fn preserves_strong_edge() {
        // Настоящая граница объекта (большой перепад) не трогается.
        let (np0, nq0) = filter_pair(10, 10, 240, 240, filter_limit(30));
        assert_eq!((np0, nq0), (10, 240));
    }

    #[test]
    fn flat_area_unchanged() {
        let (np0, nq0) = filter_pair(80, 80, 80, 80, filter_limit(63));
        assert_eq!((np0, nq0), (80, 80));
    }
}
