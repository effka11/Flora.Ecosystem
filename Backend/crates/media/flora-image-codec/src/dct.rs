//! DCT 8x8 и квантование (FIC.md §7).
//!
//! Ортонормированный DCT-II. Базисные коэффициенты зафиксированы литералами
//! (не вычисляются через `cos`): реализация детерминирована на любой
//! платформе — обязательное свойство для golden-векторов формата.
//! Матрица идентична T.81 (JPEG), поэтому перцептивные таблицы Annex K
//! применимы без пересчёта масштаба.

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
