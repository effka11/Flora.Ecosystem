//! Деблокинг-фильтр (FRC-I.md §7.6, битстрим v4, флаг-бит 5).
//!
//! Пост-фильтр **вне петли предсказания**: intra-предикция и кодер работают
//! с нефильтрованной реконструкцией (байты тайла идентичны v3), фильтр
//! применяется декодером к готовой плоскости тайла перед апсэмплингом
//! и цветовым преобразованием. Тайлы остаются полностью независимыми.
//!
//! Модель — «simple filter» VP8: на каждой границе блоков 8×8 пары
//! `p1 p0 | q0 q1` поперёк ребра корректируются, только если перепад
//! на ребре мал (иначе это настоящая деталь, не артефакт квантования):
//!
//! ```text
//! |p0 - q0| < T  и  |p1 - p0| < T/2  и  |q1 - q0| < T/2
//! d = clamp((3(q0 - p0) + (p1 - q1) + 4) >> 3, -T, T)
//! p0 += d;  q0 -= d      (кламп 0..=255)
//! ```
//!
//! Порог `T` выводится из шага квантования DC плоскости (`Q[0]`):
//! `T = clamp(Q[0] / 2, 2, 24)`. Калибровка по корпусу q=30: `Q[0]/4`
//! даёт +0.27/+0.41 dB (photo/portrait), `Q[0]/2` — +0.40/+0.44 dB;
//! дальнейшее усиление не меняет результат (ограничивает условие на
//! соседей `T/2`). Целочисленная арифметика — детерминизм.

/// Порог фильтрации из шага квантования DC.
#[inline]
pub fn threshold(dc_step: u16) -> i32 {
    (i32::from(dc_step) / 2).clamp(2, 24)
}

/// Фильтрует границы блоков 8×8 плоскости на месте.
pub fn deblock_plane(buf: &mut [i16], w: usize, h: usize, dc_step: u16) {
    debug_assert_eq!(buf.len(), w * h);
    let t = threshold(dc_step);
    // Вертикальные рёбра (x = 8, 16, ...): пары в строке. x >= 8, поэтому
    // p1 = x-2 всегда валиден; q1 за правым краем реплицируется из q0.
    for x in (8..w).step_by(8) {
        for y in 0..h {
            let i = y * w + x;
            let p1 = i32::from(buf[i - 2]);
            let p0 = i32::from(buf[i - 1]);
            let q0 = i32::from(buf[i]);
            let q1 = i32::from(buf[i + usize::from(x + 1 < w)]);
            if let Some((np0, nq0)) = filter_pair(p1, p0, q0, q1, t) {
                buf[i - 1] = np0;
                buf[i] = nq0;
            }
        }
    }
    // Горизонтальные рёбра (y = 8, 16, ...): пары в столбце (симметрично).
    for y in (8..h).step_by(8) {
        let row = y * w;
        for x in 0..w {
            let i = row + x;
            let p1 = i32::from(buf[i - 2 * w]);
            let p0 = i32::from(buf[i - w]);
            let q0 = i32::from(buf[i]);
            let q1 = i32::from(buf[i + w * usize::from(y + 1 < h)]);
            if let Some((np0, nq0)) = filter_pair(p1, p0, q0, q1, t) {
                buf[i - w] = np0;
                buf[i] = nq0;
            }
        }
    }
}

/// Корректирует пару отсчётов на ребре; `None` — ребро не фильтруется.
#[inline]
fn filter_pair(p1: i32, p0: i32, q0: i32, q1: i32, t: i32) -> Option<(i16, i16)> {
    if (p0 - q0).abs() >= t || (p1 - p0).abs() > t / 2 || (q1 - q0).abs() > t / 2 {
        return None;
    }
    let d = ((3 * (q0 - p0) + (p1 - q1) + 4) >> 3).clamp(-t, t);
    if d == 0 {
        return None;
    }
    Some(((p0 + d).clamp(0, 255) as i16, (q0 - d).clamp(0, 255) as i16))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn threshold_scales_with_quantizer() {
        assert_eq!(threshold(1), 2); // потолок снизу
        assert_eq!(threshold(16), 8);
        assert_eq!(threshold(255), 24); // потолок сверху
    }

    /// Ступенька на границе блока сглаживается, если перепад мал.
    #[test]
    fn smooths_small_block_edge() {
        let (w, h) = (16usize, 8usize);
        let mut buf: Vec<i16> = (0..w * h)
            .map(|i| if i % w < 8 { 100 } else { 106 })
            .collect();
        deblock_plane(&mut buf, w, h, 32); // T = 8
        let row = &buf[0..w];
        assert!(row[7] > 100, "p0 не сдвинулся к ребру: {row:?}");
        assert!(row[8] < 106, "q0 не сдвинулся к ребру: {row:?}");
        // Дальние отсчёты не тронуты.
        assert_eq!(row[0], 100);
        assert_eq!(row[15], 106);
    }

    /// Резкая деталь (большой перепад) не размывается.
    #[test]
    fn preserves_real_edges() {
        let (w, h) = (16usize, 8usize);
        let orig: Vec<i16> = (0..w * h)
            .map(|i| if i % w < 8 { 30 } else { 220 })
            .collect();
        let mut buf = orig.clone();
        deblock_plane(&mut buf, w, h, 32);
        assert_eq!(buf, orig, "контрастное ребро должно остаться нетронутым");
    }

    /// Однородная плоскость не меняется (d == 0).
    #[test]
    fn flat_plane_unchanged() {
        let (w, h) = (24usize, 24usize);
        let orig = vec![128i16; w * h];
        let mut buf = orig.clone();
        deblock_plane(&mut buf, w, h, 64);
        assert_eq!(buf, orig);
    }

    /// Малые плоскости (меньше блока) не паникуют.
    #[test]
    fn small_planes_no_panic() {
        for (w, h) in [(1usize, 1usize), (7, 3), (8, 8), (9, 9), (16, 1), (1, 16)] {
            let mut buf = vec![100i16; w * h];
            deblock_plane(&mut buf, w, h, 32);
        }
    }
}
