//! DCT 8x8 / 16x16 и квантование (FRC-I.md §7).
//!
//! Ортонормированный DCT-II. Базисные коэффициенты зафиксированы литералами
//! (не вычисляются через `cos`): реализация детерминирована на любой
//! платформе — обязательное свойство для golden-векторов формата.
//! Базис 16×16 строится из литералов cos(kπ/32) целочисленной свёрткой
//! индексов — тоже детерминирован (IEEE-умножение литералов).
//! Матрица 8×8 идентична T.81 (JPEG), поэтому перцептивные таблицы Annex K
//! применимы без пересчёта масштаба.

use std::sync::OnceLock;

/// 1/(2*sqrt(2)) — базис нулевой частоты.
const A0: f32 = 0.353_553_39;
/// 0.5*cos(k*pi/16) для k = 1..=7.
const C1: f32 = 0.490_392_64;
const C2: f32 = 0.461_939_77;
const C3: f32 = 0.415_734_8;
const C5: f32 = 0.277_785_1;
const C6: f32 = 0.191_341_72;
const C7: f32 = 0.097_545_16;

/// BASIS[u][n] = c(u) * cos((2n+1) * u * pi / 16).
#[rustfmt::skip]
const BASIS: [[f32; 8]; 8] = [
    [ A0,  A0,  A0,  A0,  A0,  A0,  A0,  A0],
    [ C1,  C3,  C5,  C7, -C7, -C5, -C3, -C1],
    [ C2,  C6, -C6, -C2, -C2, -C6,  C6,  C2],
    [ C3, -C7, -C1, -C5,  C5,  C1,  C7, -C3],
    [ A0, -A0, -A0,  A0,  A0, -A0, -A0,  A0],
    [ C5, -C1,  C7,  C3, -C3, -C7,  C1, -C5],
    [ C6, -C2,  C2, -C6, -C6,  C2, -C2,  C6],
    [ C7, -C5,  C3, -C1,  C1, -C3,  C5, -C7],
];

/// Прямое 2D DCT: пространственный блок (row-major, y*8+x) → частоты (u*8+v).
pub fn fdct8x8(spatial: &[f32; 64], freq: &mut [f32; 64]) {
    // По столбцам: tmp[u][x] = sum_y BASIS[u][y] * spatial[y][x].
    let mut tmp = [0f32; 64];
    for u in 0..8 {
        for x in 0..8 {
            let mut acc = 0f32;
            for y in 0..8 {
                acc += BASIS[u][y] * spatial[y * 8 + x];
            }
            tmp[u * 8 + x] = acc;
        }
    }
    // По строкам: freq[u][v] = sum_x BASIS[v][x] * tmp[u][x].
    for u in 0..8 {
        for v in 0..8 {
            let mut acc = 0f32;
            for x in 0..8 {
                acc += BASIS[v][x] * tmp[u * 8 + x];
            }
            freq[u * 8 + v] = acc;
        }
    }
}

/// Обратное 2D DCT: частоты → пространственный блок.
pub fn idct8x8(freq: &[f32; 64], spatial: &mut [f32; 64]) {
    // По строкам: tmp[u][x] = sum_v BASIS[v][x] * freq[u][v].
    let mut tmp = [0f32; 64];
    for u in 0..8 {
        for x in 0..8 {
            let mut acc = 0f32;
            for v in 0..8 {
                acc += BASIS[v][x] * freq[u * 8 + v];
            }
            tmp[u * 8 + x] = acc;
        }
    }
    // По столбцам: spatial[y][x] = sum_u BASIS[u][y] * tmp[u][x].
    for y in 0..8 {
        for x in 0..8 {
            let mut acc = 0f32;
            for u in 0..8 {
                acc += BASIS[u][y] * tmp[u * 8 + x];
            }
            spatial[y * 8 + x] = acc;
        }
    }
}

// --- 16×16 (битстрим v5) --------------------------------------------------------

/// cos(k·π/32), k = 0..=16 (литералы — детерминизм golden-векторов).
#[rustfmt::skip]
const COS32: [f32; 17] = [
    1.0,
    0.995_184_7, 0.980_785_28, 0.956_940_35, 0.923_879_5,
    0.881_921_26, 0.831_469_6, 0.773_010_45, std::f32::consts::FRAC_1_SQRT_2,
    0.634_393_3, 0.555_570_23, 0.471_396_74, 0.382_683_43,
    0.290_284_7, 0.195_090_32, 0.098_017_14, 0.0,
];
/// sqrt(1/16) — базис нулевой частоты N=16.
const B16_C0: f32 = 0.25;
/// sqrt(2/16) — масштаб остальных строк.
const B16_CU: f32 = 0.353_553_39;

/// cos(m·π/32) для произвольного m — сведение по симметриям косинуса.
fn cos32(m: usize) -> f32 {
    let m = m % 64;
    match m {
        0..=16 => COS32[m],
        17..=32 => -COS32[32 - m],
        33..=48 => -COS32[m - 32],
        _ => COS32[64 - m],
    }
}

/// BASIS16[u][n] = c(u) · cos((2n+1)·u·π/32); строится один раз.
fn basis16() -> &'static [[f32; 16]; 16] {
    static BASIS16: OnceLock<[[f32; 16]; 16]> = OnceLock::new();
    BASIS16.get_or_init(|| {
        let mut b = [[0f32; 16]; 16];
        for (u, row) in b.iter_mut().enumerate() {
            for (n, slot) in row.iter_mut().enumerate() {
                *slot = if u == 0 {
                    B16_C0
                } else {
                    B16_CU * cos32((2 * n + 1) * u)
                };
            }
        }
        b
    })
}

/// Прямое 2D DCT 16×16: пространственный блок (y*16+x) → частоты (u*16+v).
pub fn fdct16(spatial: &[f32; 256], freq: &mut [f32; 256]) {
    let basis = basis16();
    let mut tmp = [0f32; 256];
    for u in 0..16 {
        for x in 0..16 {
            let mut acc = 0f32;
            for y in 0..16 {
                acc += basis[u][y] * spatial[y * 16 + x];
            }
            tmp[u * 16 + x] = acc;
        }
    }
    for u in 0..16 {
        for v in 0..16 {
            let mut acc = 0f32;
            for x in 0..16 {
                acc += basis[v][x] * tmp[u * 16 + x];
            }
            freq[u * 16 + v] = acc;
        }
    }
}

/// Обратное 2D DCT 16×16: частоты → пространственный блок.
pub fn idct16(freq: &[f32; 256], spatial: &mut [f32; 256]) {
    let basis = basis16();
    let mut tmp = [0f32; 256];
    for u in 0..16 {
        for x in 0..16 {
            let mut acc = 0f32;
            for v in 0..16 {
                acc += basis[v][x] * freq[u * 16 + v];
            }
            tmp[u * 16 + x] = acc;
        }
    }
    for y in 0..16 {
        for x in 0..16 {
            let mut acc = 0f32;
            for u in 0..16 {
                acc += basis[u][y] * tmp[u * 16 + x];
            }
            spatial[y * 16 + x] = acc;
        }
    }
}

/// Зигзаг-сканирование 16×16 (то же серпантинное правило, что и 8×8).
pub const ZIGZAG16: [usize; 256] = {
    let mut out = [0usize; 256];
    let mut u = 0usize;
    let mut v = 0usize;
    let mut i = 0usize;
    while i < 256 {
        out[i] = u * 16 + v;
        if (u + v).is_multiple_of(2) {
            if v == 15 {
                u += 1;
            } else if u == 0 {
                v += 1;
            } else {
                u -= 1;
                v += 1;
            }
        } else if u == 15 {
            v += 1;
        } else if v == 0 {
            u += 1;
        } else {
            u += 1;
            v -= 1;
        }
        i += 1;
    }
    out
};

/// Матрица квантования 16×16 из 8×8: коэффициент (u,v) наследует шаг
/// пространственной частоты (u/2, v/2). Базис ортонормирован — одинаковый
/// шаг даёт одинаковую пиксельную ошибку независимо от размера блока,
/// поэтому качество 16×16- и 8×8-зон согласовано. Нормативно для v5.
pub fn quant_matrix16(q8: &[u16; 64]) -> [u16; 256] {
    let mut out = [0u16; 256];
    for u in 0..16 {
        for v in 0..16 {
            out[u * 16 + v] = q8[(u / 2) * 8 + v / 2];
        }
    }
    out
}

// --- спектры структурных предсказаний (кодер, свобода кодера) -------------------
//
// DCT линеен: F(orig - pred) = F(orig) - F(pred). Для мод с постоянной
// структурой спектр предсказания считается аналитически за O(N) вместо
// полного 2D-преобразования O(N^2): у константы — только DC, у вертикальной
// моды (строки одинаковы) — только строка u=0, у горизонтальной — только
// столбец v=0. Экономит 3 из 6 полных DCT на блок в RD-переборе мод.

/// Спектр константного блока 8×8: `freq[0] = 8c`, остальное 0.
pub fn fdct8x8_const(c: f32, out: &mut [f32; 64]) {
    out.fill(0.0);
    out[0] = 8.0 * c;
}

/// Спектр блока 8×8 с одинаковыми строками `row` (V-мода): строка u=0.
pub fn fdct8x8_rows(row: &[f32; 8], out: &mut [f32; 64]) {
    out.fill(0.0);
    for v in 0..8 {
        let mut acc = 0f32;
        for (x, &r) in row.iter().enumerate() {
            acc += BASIS[v][x] * r;
        }
        out[v] = 8.0 * A0 * acc;
    }
}

/// Спектр блока 8×8 с одинаковыми столбцами `col` (H-мода): столбец v=0.
pub fn fdct8x8_cols(col: &[f32; 8], out: &mut [f32; 64]) {
    out.fill(0.0);
    for u in 0..8 {
        let mut acc = 0f32;
        for (y, &c) in col.iter().enumerate() {
            acc += BASIS[u][y] * c;
        }
        out[u * 8] = 8.0 * A0 * acc;
    }
}

/// Спектр константного блока 16×16: `freq[0] = 16c`.
pub fn fdct16_const(c: f32, out: &mut [f32; 256]) {
    out.fill(0.0);
    out[0] = 16.0 * c;
}

/// Спектр блока 16×16 с одинаковыми строками (V-мода).
pub fn fdct16_rows(row: &[f32; 16], out: &mut [f32; 256]) {
    let basis = basis16();
    out.fill(0.0);
    for v in 0..16 {
        let mut acc = 0f32;
        for (x, &r) in row.iter().enumerate() {
            acc += basis[v][x] * r;
        }
        out[v] = 16.0 * B16_C0 * acc;
    }
}

/// Спектр блока 16×16 с одинаковыми столбцами (H-мода).
pub fn fdct16_cols(col: &[f32; 16], out: &mut [f32; 256]) {
    let basis = basis16();
    out.fill(0.0);
    for u in 0..16 {
        let mut acc = 0f32;
        for (y, &c) in col.iter().enumerate() {
            acc += basis[u][y] * c;
        }
        out[u * 16] = 16.0 * B16_C0 * acc;
    }
}

/// Порядок зигзаг-сканирования: позиция скана → индекс `u*8+v`.
#[rustfmt::skip]
pub const ZIGZAG: [usize; 64] = [
     0,  1,  8, 16,  9,  2,  3, 10,
    17, 24, 32, 25, 18, 11,  4,  5,
    12, 19, 26, 33, 40, 48, 41, 34,
    27, 20, 13,  6,  7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36,
    29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46,
    53, 60, 61, 54, 47, 55, 62, 63,
];

/// Базовая перцептивная таблица квантования яркости (ITU-T T.81 Annex K.1).
#[rustfmt::skip]
pub const BASE_LUMA: [u16; 64] = [
    16, 11, 10, 16,  24,  40,  51,  61,
    12, 12, 14, 19,  26,  58,  60,  55,
    14, 13, 16, 24,  40,  57,  69,  56,
    14, 17, 22, 29,  51,  87,  80,  62,
    18, 22, 37, 56,  68, 109, 103,  77,
    24, 35, 55, 64,  81, 104, 113,  92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103,  99,
];

/// Базовая таблица квантования цветоразностей (ITU-T T.81 Annex K.2).
#[rustfmt::skip]
pub const BASE_CHROMA: [u16; 64] = [
    17, 18, 24, 47, 99, 99, 99, 99,
    18, 21, 26, 66, 99, 99, 99, 99,
    24, 26, 56, 99, 99, 99, 99, 99,
    47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
];

/// Масштабирование базовой таблицы параметром качества 1..=100
/// (классическое отображение IJG: 50 — базовая таблица, 100 — почти lossless).
pub fn quant_matrix(base: &[u16; 64], quality: u8) -> [u16; 64] {
    let q = u32::from(quality.clamp(1, 100));
    let scale = if q < 50 { 5000 / q } else { 200 - 2 * q };
    let mut out = [0u16; 64];
    for (o, &b) in out.iter_mut().zip(base.iter()) {
        let v = (u32::from(b) * scale + 50) / 100;
        *o = v.clamp(1, 255) as u16;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dct_roundtrip_is_near_exact() {
        let mut spatial = [0f32; 64];
        for (i, s) in spatial.iter_mut().enumerate() {
            *s = ((i * 37 + 11) % 256) as f32 - 128.0;
        }
        let mut freq = [0f32; 64];
        let mut back = [0f32; 64];
        fdct8x8(&spatial, &mut freq);
        idct8x8(&freq, &mut back);
        for (a, b) in spatial.iter().zip(back.iter()) {
            assert!((a - b).abs() < 0.01, "{a} != {b}");
        }
    }

    #[test]
    fn dct_dc_is_scaled_mean() {
        let spatial = [80.0f32; 64];
        let mut freq = [0f32; 64];
        fdct8x8(&spatial, &mut freq);
        assert!((freq[0] - 80.0 * 8.0).abs() < 0.01);
        assert!(freq[1..].iter().all(|&c| c.abs() < 0.001));
    }

    #[test]
    fn zigzag_is_permutation() {
        let mut seen = [false; 64];
        for &z in &ZIGZAG {
            assert!(!seen[z]);
            seen[z] = true;
        }
    }

    #[test]
    fn dct16_roundtrip_is_near_exact() {
        let mut spatial = [0f32; 256];
        for (i, s) in spatial.iter_mut().enumerate() {
            *s = ((i * 37 + 11) % 256) as f32 - 128.0;
        }
        let mut freq = [0f32; 256];
        let mut back = [0f32; 256];
        fdct16(&spatial, &mut freq);
        idct16(&freq, &mut back);
        for (a, b) in spatial.iter().zip(back.iter()) {
            assert!((a - b).abs() < 0.02, "{a} != {b}");
        }
    }

    #[test]
    fn dct16_dc_is_scaled_mean() {
        let spatial = [80.0f32; 256];
        let mut freq = [0f32; 256];
        fdct16(&spatial, &mut freq);
        assert!((freq[0] - 80.0 * 16.0).abs() < 0.02);
        assert!(freq[1..].iter().all(|&c| c.abs() < 0.01));
    }

    #[test]
    fn zigzag16_is_permutation() {
        let mut seen = [false; 256];
        for &z in &ZIGZAG16 {
            assert!(!seen[z]);
            seen[z] = true;
        }
        // Начало серпантина совпадает с правилом 8×8.
        assert_eq!(&ZIGZAG16[0..4], &[0, 1, 16, 32]);
    }

    #[test]
    fn quant_matrix16_inherits_steps() {
        let q8 = quant_matrix(&BASE_LUMA, 75);
        let q16 = quant_matrix16(&q8);
        assert_eq!(q16[0], q8[0]); // DC
        for u in 0..16 {
            for v in 0..16 {
                assert_eq!(q16[u * 16 + v], q8[(u / 2) * 8 + v / 2]);
            }
        }
    }

    #[test]
    fn quality_scaling_monotonic() {
        let q10 = quant_matrix(&BASE_LUMA, 10);
        let q50 = quant_matrix(&BASE_LUMA, 50);
        let q95 = quant_matrix(&BASE_LUMA, 95);
        assert_eq!(q50, BASE_LUMA);
        for i in 0..64 {
            assert!(q10[i] >= q50[i]);
            assert!(q95[i] <= q50[i]);
            assert!(q95[i] >= 1);
        }
    }
}
