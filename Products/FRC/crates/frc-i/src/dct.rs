//! DCT/ADST 4x4 / 8x8 / 16x16 / 32x32 и квантование (FRC-I.md §7).
//!
//! Ортонормированный DCT-II. Базисные коэффициенты зафиксированы литералами
//! (не вычисляются через `cos`): реализация детерминирована на любой
//! платформе — обязательное свойство для golden-векторов формата.
//! Базис 16×16 строится из литералов cos(kπ/32) целочисленной свёрткой
//! индексов — тоже детерминирован (IEEE-умножение литералов).
//! Матрица 8×8 идентична T.81 (JPEG), поэтому перцептивные таблицы Annex K
//! применимы без пересчёта масштаба.

use std::sync::OnceLock;

/// v7.4 transform IDs (wire values).
pub const TX_DCT_DCT: u8 = 0;
pub const TX_ADST_DCT: u8 = 1;
pub const TX_DCT_ADST: u8 = 2;
pub const TX_ADST_ADST: u8 = 3;
pub const N_TX_V7: u8 = 4;

#[rustfmt::skip]
const SIN9: [f32; 5] = [
    0.0, 0.342_020_15, 0.642_787_64, 0.866_025_4, 0.984_807_7,
];
#[rustfmt::skip]
const SIN17: [f32; 9] = [
    0.0, 0.183_749_51, 0.361_241_67, 0.526_432_16, 0.673_695_6,
    0.798_017_2, 0.895_163_3, 0.961_825_67, 0.995_734_16,
];
#[rustfmt::skip]
const SIN33: [f32; 17] = [
    0.0, 0.095_056_04, 0.189_251_24, 0.281_732_56, 0.371_662_47,
    0.458_226_53, 0.540_640_83, 0.618_159, 0.690_079, 0.755_749_6,
    0.814_575_97, 0.866_025_4, 0.909_632, 0.945_000_8, 0.971_811_6,
    0.989_821_43, 0.998_867_33,
];
#[rustfmt::skip]
const SIN65: [f32; 33] = [
    0.0, 0.048_313_38, 0.096_513_92, 0.144_489_05, 0.192_126_72,
    0.239_315_66, 0.285_945_68, 0.331_907_84, 0.377_094_83,
    0.421_401_1, 0.464_723_17, 0.506_959_86, 0.548_012_5,
    0.587_785_24, 0.626_185_2, 0.663_122_65, 0.698_511_36,
    0.732_268_7, 0.764_315_7, 0.794_577_66, 0.822_983_86,
    0.849_467_93, 0.873_968, 0.896_426_9, 0.916_792_2,
    0.935_016_2, 0.951_056_54, 0.964_875_6, 0.976_441_1,
    0.985_726_06, 0.992_708_86, 0.997_373_16, 0.999_708,
];

fn sin_odd_den<const M: usize>(table: &[f32; M], denominator: usize, multiple: usize) -> f32 {
    let m = multiple % (2 * denominator);
    let (negative, within_pi) = if m > denominator {
        (true, m - denominator)
    } else {
        (false, m)
    };
    let index = if within_pi > denominator / 2 {
        denominator - within_pi
    } else {
        within_pi
    };
    let value = table[index];
    if negative { -value } else { value }
}

fn make_adst_basis<const N: usize, const M: usize>(
    table: &[f32; M],
    denominator: usize,
    scale: f32,
) -> [[f32; N]; N] {
    let mut basis = [[0f32; N]; N];
    for (k, row) in basis.iter_mut().enumerate() {
        for (n, value) in row.iter_mut().enumerate() {
            *value = scale * sin_odd_den(table, denominator, (2 * n + 1) * (k + 1));
        }
    }
    basis
}

fn adst_basis4() -> &'static [[f32; 4]; 4] {
    static BASIS: OnceLock<[[f32; 4]; 4]> = OnceLock::new();
    BASIS.get_or_init(|| make_adst_basis(&SIN9, 9, 0.666_666_7))
}

fn adst_basis8() -> &'static [[f32; 8]; 8] {
    static BASIS: OnceLock<[[f32; 8]; 8]> = OnceLock::new();
    BASIS.get_or_init(|| make_adst_basis(&SIN17, 17, 0.485_071_24))
}

fn adst_basis16() -> &'static [[f32; 16]; 16] {
    static BASIS: OnceLock<[[f32; 16]; 16]> = OnceLock::new();
    BASIS.get_or_init(|| make_adst_basis(&SIN33, 33, 0.348_155_32))
}

fn adst_basis32() -> &'static [[f32; 32]; 32] {
    static BASIS: OnceLock<[[f32; 32]; 32]> = OnceLock::new();
    BASIS.get_or_init(|| make_adst_basis(&SIN65, 65, 0.248_069_47))
}

// --- 4×4 (экспериментальная линия v7.2) ---------------------------------------

#[rustfmt::skip]
const BASIS4: [[f32; 4]; 4] = [
    [ 0.5,         0.5,         0.5,         0.5        ],
    [ 0.653_281_5, 0.270_598_05,-0.270_598_05,-0.653_281_5],
    [ 0.5,        -0.5,        -0.5,         0.5        ],
    [ 0.270_598_05,-0.653_281_5,0.653_281_5, -0.270_598_05],
];

pub fn fdct4(spatial: &[f32; 16], freq: &mut [f32; 16]) {
    let mut tmp = [0f32; 16];
    for u in 0..4 {
        for x in 0..4 {
            let mut acc = 0f32;
            for y in 0..4 {
                acc += BASIS4[u][y] * spatial[y * 4 + x];
            }
            tmp[u * 4 + x] = acc;
        }
    }
    for u in 0..4 {
        for v in 0..4 {
            let mut acc = 0f32;
            for x in 0..4 {
                acc += BASIS4[v][x] * tmp[u * 4 + x];
            }
            freq[u * 4 + v] = acc;
        }
    }
}

pub fn idct4(freq: &[f32; 16], spatial: &mut [f32; 16]) {
    let mut tmp = [0f32; 16];
    for u in 0..4 {
        for x in 0..4 {
            let mut acc = 0f32;
            for v in 0..4 {
                acc += BASIS4[v][x] * freq[u * 4 + v];
            }
            tmp[u * 4 + x] = acc;
        }
    }
    for y in 0..4 {
        for x in 0..4 {
            let mut acc = 0f32;
            for u in 0..4 {
                acc += BASIS4[u][y] * tmp[u * 4 + x];
            }
            spatial[y * 4 + x] = acc;
        }
    }
}

#[rustfmt::skip]
pub const ZIGZAG4: [usize; 16] = [
     0,  1,  4,  8,
     5,  2,  3,  6,
     9, 12, 13, 10,
     7, 11, 14, 15,
];

pub fn quant_matrix4(q8: &[u16; 64]) -> [u16; 16] {
    let mut out = [0u16; 16];
    for u in 0..4 {
        for v in 0..4 {
            out[u * 4 + v] = q8[(u * 2) * 8 + v * 2];
        }
    }
    out
}

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

// --- 32×32 (экспериментальная линия v7.2) -------------------------------------

/// cos(k·π/64), k = 0..=32. Литералы фиксируют межплатформенный битстрим.
#[rustfmt::skip]
const COS64: [f32; 33] = [
    1.0,
    0.998_795_45, 0.995_184_7,  0.989_176_5,  0.980_785_25,
    0.970_031_26, 0.956_940_35, 0.941_544_06, 0.923_879_5,
    0.903_989_3,  0.881_921_3,  0.857_728_6,  0.831_469_6,
    0.803_207_5,  0.773_010_43, 0.740_951_1,  std::f32::consts::FRAC_1_SQRT_2,
    0.671_558_9,  0.634_393_3,  0.595_699_3,  0.555_570_24,
    0.514_102_76, 0.471_396_74, 0.427_555_08, 0.382_683_43,
    0.336_889_86, 0.290_284_66, 0.242_980_18, 0.195_090_32,
    0.146_730_47, 0.098_017_14, 0.049_067_676, 0.0,
];
/// sqrt(1/32) — базис нулевой частоты N=32.
const B32_C0: f32 = 0.176_776_69;
/// sqrt(2/32) — масштаб остальных строк.
const B32_CU: f32 = 0.25;

fn cos64(m: usize) -> f32 {
    let m = m % 128;
    match m {
        0..=32 => COS64[m],
        33..=64 => -COS64[64 - m],
        65..=96 => -COS64[m - 64],
        _ => COS64[128 - m],
    }
}

fn basis32() -> &'static [[f32; 32]; 32] {
    static BASIS32: OnceLock<[[f32; 32]; 32]> = OnceLock::new();
    BASIS32.get_or_init(|| {
        let mut b = [[0f32; 32]; 32];
        for (u, row) in b.iter_mut().enumerate() {
            for (n, slot) in row.iter_mut().enumerate() {
                *slot = if u == 0 {
                    B32_C0
                } else {
                    B32_CU * cos64((2 * n + 1) * u)
                };
            }
        }
        b
    })
}

/// Прямое 2D DCT 32×32.
pub fn fdct32(spatial: &[f32; 1024], freq: &mut [f32; 1024]) {
    let basis = basis32();
    let mut tmp = [0f32; 1024];
    for u in 0..32 {
        for x in 0..32 {
            let mut acc = 0f32;
            for y in 0..32 {
                acc += basis[u][y] * spatial[y * 32 + x];
            }
            tmp[u * 32 + x] = acc;
        }
    }
    for u in 0..32 {
        for v in 0..32 {
            let mut acc = 0f32;
            for x in 0..32 {
                acc += basis[v][x] * tmp[u * 32 + x];
            }
            freq[u * 32 + v] = acc;
        }
    }
}

/// Обратное 2D DCT 32×32.
pub fn idct32(freq: &[f32; 1024], spatial: &mut [f32; 1024]) {
    let basis = basis32();
    let mut tmp = [0f32; 1024];
    for u in 0..32 {
        for x in 0..32 {
            let mut acc = 0f32;
            for v in 0..32 {
                acc += basis[v][x] * freq[u * 32 + v];
            }
            tmp[u * 32 + x] = acc;
        }
    }
    for y in 0..32 {
        for x in 0..32 {
            let mut acc = 0f32;
            for u in 0..32 {
                acc += basis[u][y] * tmp[u * 32 + x];
            }
            spatial[y * 32 + x] = acc;
        }
    }
}

/// Зигзаг-сканирование 32×32.
pub const ZIGZAG32: [usize; 1024] = {
    let mut out = [0usize; 1024];
    let mut u = 0usize;
    let mut v = 0usize;
    let mut i = 0usize;
    while i < 1024 {
        out[i] = u * 32 + v;
        if (u + v).is_multiple_of(2) {
            if v == 31 {
                u += 1;
            } else if u == 0 {
                v += 1;
            } else {
                u -= 1;
                v += 1;
            }
        } else if u == 31 {
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

/// Матрица квантования 32×32 из 8×8 по относительной частоте.
pub fn quant_matrix32(q8: &[u16; 64]) -> [u16; 1024] {
    let mut out = [0u16; 1024];
    for u in 0..32 {
        for v in 0..32 {
            out[u * 32 + v] = q8[(u / 4) * 8 + v / 4];
        }
    }
    out
}

fn forward_separable<const N: usize, const LEN: usize>(
    spatial: &[f32; LEN],
    freq: &mut [f32; LEN],
    vertical: &[[f32; N]; N],
    horizontal: &[[f32; N]; N],
) {
    debug_assert_eq!(LEN, N * N);
    let mut tmp = [0f32; LEN];
    for u in 0..N {
        for x in 0..N {
            let mut acc = 0f32;
            for y in 0..N {
                acc += vertical[u][y] * spatial[y * N + x];
            }
            tmp[u * N + x] = acc;
        }
    }
    for u in 0..N {
        for v in 0..N {
            let mut acc = 0f32;
            for x in 0..N {
                acc += horizontal[v][x] * tmp[u * N + x];
            }
            freq[u * N + v] = acc;
        }
    }
}

fn inverse_separable<const N: usize, const LEN: usize>(
    freq: &[f32; LEN],
    spatial: &mut [f32; LEN],
    vertical: &[[f32; N]; N],
    horizontal: &[[f32; N]; N],
) {
    debug_assert_eq!(LEN, N * N);
    let mut tmp = [0f32; LEN];
    for u in 0..N {
        for x in 0..N {
            let mut acc = 0f32;
            for v in 0..N {
                acc += horizontal[v][x] * freq[u * N + v];
            }
            tmp[u * N + x] = acc;
        }
    }
    for y in 0..N {
        for x in 0..N {
            let mut acc = 0f32;
            for u in 0..N {
                acc += vertical[u][y] * tmp[u * N + x];
            }
            spatial[y * N + x] = acc;
        }
    }
}

fn forward_tx<const N: usize, const LEN: usize>(
    spatial: &[f32; LEN],
    freq: &mut [f32; LEN],
    dct: &[[f32; N]; N],
    adst: &[[f32; N]; N],
    tx: u8,
) {
    let (vertical, horizontal) = match tx {
        TX_DCT_DCT => (dct, dct),
        TX_ADST_DCT => (adst, dct),
        TX_DCT_ADST => (dct, adst),
        TX_ADST_ADST => (adst, adst),
        _ => unreachable!("transform ID validated by caller"),
    };
    forward_separable::<N, LEN>(spatial, freq, vertical, horizontal);
}

fn inverse_tx<const N: usize, const LEN: usize>(
    freq: &[f32; LEN],
    spatial: &mut [f32; LEN],
    dct: &[[f32; N]; N],
    adst: &[[f32; N]; N],
    tx: u8,
) {
    let (vertical, horizontal) = match tx {
        TX_DCT_DCT => (dct, dct),
        TX_ADST_DCT => (adst, dct),
        TX_DCT_ADST => (dct, adst),
        TX_ADST_ADST => (adst, adst),
        _ => unreachable!("transform ID validated by caller"),
    };
    inverse_separable::<N, LEN>(freq, spatial, vertical, horizontal);
}

pub fn forward_tx4(spatial: &[f32; 16], freq: &mut [f32; 16], tx: u8) {
    if tx == TX_DCT_DCT {
        fdct4(spatial, freq);
    } else {
        forward_tx::<4, 16>(spatial, freq, &BASIS4, adst_basis4(), tx);
    }
}

pub fn inverse_tx4(freq: &[f32; 16], spatial: &mut [f32; 16], tx: u8) {
    if tx == TX_DCT_DCT {
        idct4(freq, spatial);
    } else {
        inverse_tx::<4, 16>(freq, spatial, &BASIS4, adst_basis4(), tx);
    }
}

pub fn forward_tx8(spatial: &[f32; 64], freq: &mut [f32; 64], tx: u8) {
    if tx == TX_DCT_DCT {
        fdct8x8(spatial, freq);
    } else {
        forward_tx::<8, 64>(spatial, freq, &BASIS, adst_basis8(), tx);
    }
}

pub fn inverse_tx8(freq: &[f32; 64], spatial: &mut [f32; 64], tx: u8) {
    if tx == TX_DCT_DCT {
        idct8x8(freq, spatial);
    } else {
        inverse_tx::<8, 64>(freq, spatial, &BASIS, adst_basis8(), tx);
    }
}

pub fn forward_tx16(spatial: &[f32; 256], freq: &mut [f32; 256], tx: u8) {
    if tx == TX_DCT_DCT {
        fdct16(spatial, freq);
    } else {
        forward_tx::<16, 256>(spatial, freq, basis16(), adst_basis16(), tx);
    }
}

pub fn inverse_tx16(freq: &[f32; 256], spatial: &mut [f32; 256], tx: u8) {
    if tx == TX_DCT_DCT {
        idct16(freq, spatial);
    } else {
        inverse_tx::<16, 256>(freq, spatial, basis16(), adst_basis16(), tx);
    }
}

pub fn forward_tx32(spatial: &[f32; 1024], freq: &mut [f32; 1024], tx: u8) {
    if tx == TX_DCT_DCT {
        fdct32(spatial, freq);
    } else {
        forward_tx::<32, 1024>(spatial, freq, basis32(), adst_basis32(), tx);
    }
}

pub fn inverse_tx32(freq: &[f32; 1024], spatial: &mut [f32; 1024], tx: u8) {
    if tx == TX_DCT_DCT {
        idct32(freq, spatial);
    } else {
        inverse_tx::<32, 1024>(freq, spatial, basis32(), adst_basis32(), tx);
    }
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

pub fn fdct4_const(c: f32, out: &mut [f32; 16]) {
    out.fill(0.0);
    out[0] = 4.0 * c;
}

pub fn fdct4_rows(row: &[f32; 4], out: &mut [f32; 16]) {
    out.fill(0.0);
    for v in 0..4 {
        let mut acc = 0f32;
        for (x, &r) in row.iter().enumerate() {
            acc += BASIS4[v][x] * r;
        }
        out[v] = 2.0 * acc;
    }
}

pub fn fdct4_cols(col: &[f32; 4], out: &mut [f32; 16]) {
    out.fill(0.0);
    for u in 0..4 {
        let mut acc = 0f32;
        for (y, &c) in col.iter().enumerate() {
            acc += BASIS4[u][y] * c;
        }
        out[u * 4] = 2.0 * acc;
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

/// Спектр константного блока 32×32.
pub fn fdct32_const(c: f32, out: &mut [f32; 1024]) {
    out.fill(0.0);
    out[0] = 32.0 * c;
}

/// Спектр блока 32×32 с одинаковыми строками (V-мода).
pub fn fdct32_rows(row: &[f32; 32], out: &mut [f32; 1024]) {
    let basis = basis32();
    out.fill(0.0);
    for v in 0..32 {
        let mut acc = 0f32;
        for (x, &r) in row.iter().enumerate() {
            acc += basis[v][x] * r;
        }
        out[v] = 32.0 * B32_C0 * acc;
    }
}

/// Спектр блока 32×32 с одинаковыми столбцами (H-мода).
pub fn fdct32_cols(col: &[f32; 32], out: &mut [f32; 1024]) {
    let basis = basis32();
    out.fill(0.0);
    for u in 0..32 {
        let mut acc = 0f32;
        for (y, &c) in col.iter().enumerate() {
            acc += basis[u][y] * c;
        }
        out[u * 32] = 32.0 * B32_C0 * acc;
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
    fn dct4_roundtrip_is_near_exact() {
        let mut spatial = [0f32; 16];
        for (i, s) in spatial.iter_mut().enumerate() {
            *s = ((i * 37 + 11) % 256) as f32 - 128.0;
        }
        let mut freq = [0f32; 16];
        let mut back = [0f32; 16];
        fdct4(&spatial, &mut freq);
        idct4(&freq, &mut back);
        for (a, b) in spatial.iter().zip(back.iter()) {
            assert!((a - b).abs() < 0.01, "{a} != {b}");
        }
    }

    #[test]
    fn zigzag4_is_permutation() {
        let mut seen = [false; 16];
        for &z in &ZIGZAG4 {
            assert!(!seen[z]);
            seen[z] = true;
        }
    }

    #[test]
    fn quant_matrix4_inherits_relative_steps() {
        let q8 = quant_matrix(&BASE_LUMA, 75);
        let q4 = quant_matrix4(&q8);
        for u in 0..4 {
            for v in 0..4 {
                assert_eq!(q4[u * 4 + v], q8[(u * 2) * 8 + v * 2]);
            }
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
    fn dct32_roundtrip_is_near_exact() {
        let mut spatial = [0f32; 1024];
        for (i, s) in spatial.iter_mut().enumerate() {
            *s = ((i * 37 + 11) % 256) as f32 - 128.0;
        }
        let mut freq = [0f32; 1024];
        let mut back = [0f32; 1024];
        fdct32(&spatial, &mut freq);
        idct32(&freq, &mut back);
        for (a, b) in spatial.iter().zip(back.iter()) {
            assert!((a - b).abs() < 0.05, "{a} != {b}");
        }
    }

    #[test]
    fn dct32_dc_is_scaled_mean() {
        let spatial = [80.0f32; 1024];
        let mut freq = [0f32; 1024];
        fdct32(&spatial, &mut freq);
        assert!((freq[0] - 80.0 * 32.0).abs() < 0.05);
        assert!(freq[1..].iter().all(|&c| c.abs() < 0.03));
    }

    #[test]
    fn zigzag32_is_permutation() {
        let mut seen = [false; 1024];
        for &z in &ZIGZAG32 {
            assert!(!seen[z]);
            seen[z] = true;
        }
        assert_eq!(&ZIGZAG32[0..4], &[0, 1, 32, 64]);
    }

    #[test]
    fn quant_matrix32_inherits_steps() {
        let q8 = quant_matrix(&BASE_LUMA, 75);
        let q32 = quant_matrix32(&q8);
        assert_eq!(q32[0], q8[0]);
        for u in 0..32 {
            for v in 0..32 {
                assert_eq!(q32[u * 32 + v], q8[(u / 4) * 8 + v / 4]);
            }
        }
    }

    fn assert_tx_roundtrip<const LEN: usize>(
        forward: fn(&[f32; LEN], &mut [f32; LEN], u8),
        inverse: fn(&[f32; LEN], &mut [f32; LEN], u8),
        tolerance: f32,
    ) {
        let mut spatial = [0f32; LEN];
        for (i, sample) in spatial.iter_mut().enumerate() {
            *sample = ((i * 37 + 11) % 256) as f32 - 128.0;
        }
        for tx in 0..N_TX_V7 {
            let mut freq = [0f32; LEN];
            let mut back = [0f32; LEN];
            forward(&spatial, &mut freq, tx);
            inverse(&freq, &mut back, tx);
            let max_error = spatial
                .iter()
                .zip(&back)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0f32, f32::max);
            assert!(
                max_error < tolerance,
                "tx={tx} LEN={LEN}: max error {max_error}"
            );
        }
    }

    #[test]
    fn v74_transforms_are_symmetric_at_all_sizes() {
        assert_tx_roundtrip(forward_tx4, inverse_tx4, 0.01);
        assert_tx_roundtrip(forward_tx8, inverse_tx8, 0.02);
        assert_tx_roundtrip(forward_tx16, inverse_tx16, 0.03);
        assert_tx_roundtrip(forward_tx32, inverse_tx32, 0.06);
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
