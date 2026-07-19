//! Lossy-кодер плоскости (FRC-I.md §7): intra-предикция от реконструированных
//! соседей, DCT 8x8 остатка, перцептивное квантование с dead-zone,
//! run/level кодирование AC-коэффициентов.
//!
//! Эволюция версий (декодеры старых версий сохраняются навсегда):
//!
//! - **v1** — без предикции (центрирование 128), DC-цепочка, 5 контекстов.
//! - **v2** — intra-моды DC/V/H/TM (модель VP8), DC остатка напрямую,
//!   контекст моды (6 контекстов).
//! - **v3** — + диагональные моды D45/D135. Раскладка контекстов не меняется.
//! - **v4** — деблокинг-фильтр (заголовок); слой блоков идентичен v3.
//! - **v5** — адаптивные размеры блоков: суперблок 16×16 кодируется целиком
//!   (одна мода + DCT 16×16) либо расщепляется на четыре 8×8 (слой v3).
//!   Новый контекст split (7 контекстов).
//! - **v7** — адаптивная энтропия, дерево 32→16→8→4, SMOOTH и chroma-from-luma;
//!   замороженная реализация дерева/предикции изолирована в `lossy::v72`.
//!
//! AC-контексты по заполненности соседних блоков (сумма nnz слева/сверху,
//! модель JXL/AV1) были реализованы и измерены при разработке v3 — на всём
//! корпусе они ухудшают плотность (+5..8%): разбиение статистики на бакеты
//! платит за дополнительные частотные таблицы тайла больше, чем выигрывает
//! от условности, а внутри тайла распределение достаточно однородно.
//! Как и в lossless (run-режим, bias-коррекция), приёмы кодеков с
//! адаптивными вероятностями не переносятся на статические таблицы rANS.

use crate::arith::{ModelBank, RangeDecoder};
use crate::bits::{BitReader, BitWriter};
use crate::dct::{
    N_TX_V7, TX_ADST_ADST, TX_ADST_DCT, TX_DCT_ADST, TX_DCT_DCT, ZIGZAG, ZIGZAG16, fdct8x8,
    fdct8x8_cols, fdct8x8_const, fdct8x8_rows, fdct16, fdct16_cols, fdct16_const, fdct16_rows,
    forward_tx8, forward_tx16, idct8x8, idct16, inverse_tx8, inverse_tx16, quant_matrix16,
    tx_scan4, tx_scan8, tx_scan16, tx_scan32,
};
use crate::error::DecodeError;
use crate::rans::RansDecoder;
use crate::section::Section;
use crate::tokens::{detokenize, tokenize, unzigzag, write_raw, zigzag};

mod v72;

/// Контексты v1: DC, run (низкие/высокие частоты), level (низкие/высокие).
pub const N_CTX_V1: usize = 5;
/// Контексты v2/v3: + мода intra-предикции.
pub const N_CTX_V2: usize = 6;
/// v3 использует раскладку v2 (меняется только число мод).
pub const N_CTX_V3: usize = N_CTX_V2;
/// Контексты v5: + split-решение суперблока.
pub const N_CTX_V5: usize = 7;

const CTX_DC: u8 = 0;
const CTX_RUN_LOW: u8 = 1;
const CTX_RUN_HIGH: u8 = 2;
const CTX_LEVEL_LOW: u8 = 3;
const CTX_LEVEL_HIGH: u8 = 4;
/// Мода intra-предикции блока (v2/v3).
const CTX_MODE: u8 = 5;
/// Split-решение суперблока 16×16 (v5): 0 — целиком, 1 — четыре 8×8.
const CTX_SPLIT: u8 = 6;

/// Символ конца блока в run-контекстах (run <= 62 занимает символы <= 17).
const EOB_SYM: u8 = 31;
/// Граница низкочастотной зоны зигзага.
const LOW_BAND_END: usize = 15;
/// Граница низкочастотной зоны зигзага 16×16 (та же доля скана, что и 8×8).
const LOW_BAND_END16: usize = 63;

/// Моды intra-предсказания (значения фиксированы форматом).
const MODE_DC: u8 = 0;
const MODE_V: u8 = 1;
const MODE_H: u8 = 2;
const MODE_TM: u8 = 3;
/// Диагональ вниз-влево (только v3).
const MODE_D45: u8 = 4;
/// Диагональ вниз-вправо (только v3).
const MODE_D135: u8 = 5;
/// Двумерный плавный градиент к дальним значениям top/left (v7.3).
const MODE_SMOOTH: u8 = 6;
/// Начало chroma-from-luma мод v7.3b; mode-base кодирует фиксированный α Q4.
const MODE_CFL_BASE: u8 = 7;
const N_MODES_V2: u8 = 4;
const N_MODES_V3: u8 = 6;
const N_MODES_V7_INTRA: u8 = 7;
const N_MODES_V7: u8 = 15;
/// Моды, которые encoder рассматривает в v7. Decoder принимает весь wire-
/// диапазон `0..N_MODES_V7`, поэтому проигрышную моду можно отключить здесь,
/// не нарушив симметрию замороженного битстрима.
const ENCODE_MODES_V7: &[u8] = &[
    MODE_DC,
    MODE_V,
    MODE_H,
    MODE_TM,
    MODE_D45,
    MODE_D135,
    MODE_SMOOTH,
];
/// CfL α в Q4: −1/2, −1/4, −1/8, −1/16, +1/16, +1/8, +1/4, +1/2.
const CFL_ALPHA_Q4: [i32; 8] = [-8, -4, -2, -1, 1, 2, 4, 8];

/// Смещение округления AC при квантовании (dead-zone). DC округляется
/// классически (0.5). Мёртвая зона обнуляет слабые коэффициенты, экономя
/// run/level-токены при минимальной потере PSNR: на корпусе −12.7% размера
/// за −0.08 dB (q=75, photo) против округления 0.5. Свобода кодера.
const AC_BIAS: f32 = 0.40;

// --- adaptive quantization (v3, свобода кодера; FRC-I.md §8) -------------------
//
// Перцептивное маскирование: в текстурных блоках ошибки квантования не видны,
// в гладких — видны (бандинг). Кодер варьирует dead-zone AC по активности
// блока-источника: гладкие блоки получают округление ближе к классическому
// (сохранение градиентов), насыщенные — более агрессивное обнуление.
// Формат не меняется: деквантование остаётся `c * Q[i]`, меняется только
// выбор `c`. Применяется только в кодере v3: пути v1/v2 замораживают
// поведение, которым сгенерированы decode-freeze golden-вектора.

/// Активность ниже — блок «гладкий», bias = `AQ_BIAS_FLAT`.
const AQ_ACT_LO: f32 = 4.0;
/// Активность выше — блок «насыщенный», bias = `AQ_BIAS_BUSY`.
const AQ_ACT_HI: f32 = 16.0;
/// Dead-zone гладких блоков = базовый (никогда не мягче: рост bias выше
/// 0.40 на фотоклассах меняет байты на неощутимую точность — измерено).
const AQ_BIAS_FLAT: f32 = AC_BIAS;
/// Dead-zone насыщенных блоков: агрессивнее (ошибки маскируются текстурой).
const AQ_BIAS_BUSY: f32 = 0.18;

/// Активность блока: среднее абсолютное отклонение отсчётов от среднего.
fn block_activity(block: &[i32; 64]) -> f32 {
    let mean = block.iter().sum::<i32>() / 64;
    let mad: i32 = block.iter().map(|&v| (v - mean).abs()).sum();
    mad as f32 / 64.0
}

/// Линейная интерполяция bias по активности между двумя опорными точками.
fn adaptive_ac_bias(activity: f32) -> f32 {
    if activity <= AQ_ACT_LO {
        return AQ_BIAS_FLAT;
    }
    if activity >= AQ_ACT_HI {
        return AQ_BIAS_BUSY;
    }
    let t = (activity - AQ_ACT_LO) / (AQ_ACT_HI - AQ_ACT_LO);
    AQ_BIAS_FLAT + t * (AQ_BIAS_BUSY - AQ_BIAS_FLAT)
}

/// v7.8: scalar qmatrix already balances frequency error; the legacy
/// activity mask over-prunes textured AC. Kept separate so v1-v6 reference
/// encoder decisions remain frozen.
const AC_BIAS_V7: f32 = AC_BIAS;

#[inline]
fn run_ctx(pos: usize) -> u8 {
    if pos <= LOW_BAND_END {
        CTX_RUN_LOW
    } else {
        CTX_RUN_HIGH
    }
}

#[inline]
fn level_ctx(pos: usize) -> u8 {
    if pos <= LOW_BAND_END {
        CTX_LEVEL_LOW
    } else {
        CTX_LEVEL_HIGH
    }
}

/// Собирает блок 8x8 с репликацией краёв (без центрирования).
fn gather_block_i32(buf: &[i16], w: usize, h: usize, bx: usize, by: usize) -> [i32; 64] {
    let mut block = [0i32; 64];
    for y in 0..8 {
        let sy = (by * 8 + y).min(h - 1);
        for x in 0..8 {
            let sx = (bx * 8 + x).min(w - 1);
            block[y * 8 + x] = i32::from(buf[sy * w + sx]);
        }
    }
    block
}

// --- intra-предикция ----------------------------------------------------------

/// Граница блока из реконструкции: верхняя строка (расширенная вправо на 8
/// отсчётов для D45), левый столбец, угол. Недоступные соседи замещаются 128
/// (координаты клампятся в валидную зону — репликация края реконструкции).
struct Border {
    /// `above[0..8]` — над блоком, `above[8..16]` — над блоком справа.
    above: [i32; 16],
    left: [i32; 8],
    corner: i32,
}

fn border(recon: &[i16], w: usize, h: usize, bx: usize, by: usize) -> Border {
    let (px, py) = (bx * 8, by * 8);
    let mut above = [128i32; 16];
    let mut left = [128i32; 8];
    let mut corner = 128i32;
    if py > 0 {
        let ay = py - 1;
        for (i, a) in above.iter_mut().enumerate() {
            *a = i32::from(recon[ay * w + (px + i).min(w - 1)]);
        }
    }
    if px > 0 {
        let ax = px - 1;
        for (i, l) in left.iter_mut().enumerate() {
            *l = i32::from(recon[(py + i).min(h - 1) * w + ax]);
        }
    }
    if px > 0 && py > 0 {
        corner = i32::from(recon[(py - 1) * w + px - 1]);
    }
    Border {
        above,
        left,
        corner,
    }
}

#[inline]
fn smooth_sample(above: &[i32], left: &[i32], x: usize, y: usize) -> i32 {
    let n = left.len() as i32;
    let x_i32 = x as i32;
    let y_i32 = y as i32;
    let vertical = ((n - 1 - y_i32) * above[x] + (y_i32 + 1) * left[left.len() - 1] + n / 2) / n;
    let horizontal = ((n - 1 - x_i32) * left[y] + (x_i32 + 1) * above[left.len() - 1] + n / 2) / n;
    (vertical + horizontal + 1) >> 1
}

#[inline]
fn cfl_alpha_q4(mode: u8) -> Option<i32> {
    mode.checked_sub(MODE_CFL_BASE)
        .and_then(|i| CFL_ALPHA_Q4.get(usize::from(i)).copied())
}

#[inline]
fn round_shift_q4(value: i32) -> i32 {
    if value >= 0 {
        (value + 8) >> 4
    } else {
        -((-value + 8) >> 4)
    }
}

fn predict_cfl<const LEN: usize>(luma: &[i32; LEN], dc: i32, mode: u8) -> [i32; LEN] {
    let alpha = cfl_alpha_q4(mode).expect("CfL mode checked by caller");
    let mean = (luma.iter().sum::<i32>() + LEN as i32 / 2) / LEN as i32;
    let mut out = [0i32; LEN];
    for (dst, &y) in out.iter_mut().zip(luma.iter()) {
        *dst = (dc + round_shift_q4(alpha * (y - mean))).clamp(0, 255);
    }
    out
}

fn cfl_candidate_mode<const LEN: usize>(orig: &[i32; LEN], luma: &[i32; LEN], dc: i32) -> u8 {
    let mean = (luma.iter().sum::<i32>() + LEN as i32 / 2) / LEN as i32;
    let mut covariance = 0i64;
    let mut variance = 0i64;
    for (&c, &y) in orig.iter().zip(luma.iter()) {
        let y_ac = i64::from(y - mean);
        covariance += i64::from(c - dc) * y_ac;
        variance += y_ac * y_ac;
    }
    if variance == 0 || covariance == 0 {
        return 10;
    }
    let scaled = covariance * 16;
    let alpha = if scaled >= 0 {
        (scaled + variance / 2) / variance
    } else {
        -((-scaled + variance / 2) / variance)
    }
    .clamp(-8, 8);
    let magnitude = alpha.unsigned_abs();
    let magnitude = match magnitude {
        0 | 1 => 1,
        2 | 3 => 2,
        4..=6 => 4,
        _ => 8,
    };
    match (alpha < 0, magnitude) {
        (true, 8) => 7,
        (true, 4) => 8,
        (true, 2) => 9,
        (true, _) => 10,
        (false, 1) => 11,
        (false, 2) => 12,
        (false, 4) => 13,
        (false, _) => 14,
    }
}

#[inline]
fn mode_limit_v7(cfl: bool) -> u8 {
    if cfl { N_MODES_V7 } else { N_MODES_V7_INTRA }
}

/// Предсказание блока модой `mode` от границы.
fn predict_block(b: &Border, mode: u8) -> [i32; 64] {
    let mut out = [0i32; 64];
    match mode {
        MODE_V => {
            for y in 0..8 {
                out[y * 8..y * 8 + 8].copy_from_slice(&b.above[0..8]);
            }
        }
        MODE_H => {
            for y in 0..8 {
                out[y * 8..y * 8 + 8].copy_from_slice(&[b.left[y]; 8]);
            }
        }
        MODE_TM => {
            for y in 0..8 {
                for x in 0..8 {
                    out[y * 8 + x] = (b.left[y] + b.above[x] - b.corner).clamp(0, 255);
                }
            }
        }
        MODE_D45 => {
            // Вниз-влево: сглаженная диагональ из расширенной верхней строки.
            for y in 0..8 {
                for x in 0..8 {
                    let s = x + y;
                    let (a0, a1, a2) = (b.above[s], b.above[s + 1], b.above[(s + 2).min(15)]);
                    out[y * 8 + x] = (a0 + 2 * a1 + a2 + 2) >> 2;
                }
            }
        }
        MODE_D135 => {
            // Вниз-вправо: сглаженная диагональ из left / corner / above.
            // Опорный ряд: left[7..0], corner, above[0..8] (индексация d).
            let mut line = [0i32; 17];
            for (j, slot) in line[0..8].iter_mut().enumerate() {
                *slot = b.left[7 - j];
            }
            line[8] = b.corner;
            line[9..17].copy_from_slice(&b.above[0..8]);
            for y in 0..8 {
                for x in 0..8 {
                    // d = 8 + (x - y): 1..=15 — сглаживаем по трём соседям.
                    let d = 8 + x - y; // x,y в 0..8 => d в 1..=15 (usize безопасно)
                    out[y * 8 + x] = (line[d - 1] + 2 * line[d] + line[d + 1] + 2) >> 2;
                }
            }
        }
        MODE_SMOOTH => {
            for y in 0..8 {
                for x in 0..8 {
                    out[y * 8 + x] = smooth_sample(&b.above, &b.left, x, y);
                }
            }
        }
        _ => {
            // DC: среднее 16 граничных отсчётов (замещённые участвуют).
            let sum: i32 = b.above[0..8].iter().sum::<i32>() + b.left.iter().sum::<i32>();
            let dc = (sum + 8) >> 4;
            out.fill(dc);
        }
    }
    out
}

/// Множитель лагранжиана RD-выбора моды: `λ = LAMBDA_SCALE · qstep²`,
/// где qstep — средний шаг квантования матрицы (модель H.264/HEVC).
/// Калибровка по корпусу: плато 0.05..10 (решения совпадают), ниже —
/// кодер игнорирует rate и раздувает поток; выбран центр плато.
const LAMBDA_SCALE: f32 = 0.85;

/// Число мод, проходящих полный RD после SAD-предотбора (свобода кодера).
/// Калибровка по корпусу q=75: топ-4 из 6 нейтрален по размеру/PSNR
/// (±0.1..0.6%, уровень шума), топ-3 теряет ~1% на портрете.
const RD_CANDIDATES: usize = 4;
/// То же для суперблоков 16×16: DCT дороже, а разброс мод меньше.
const RD_CANDIDATES16: usize = 3;

/// SAD-предотбор: индексы `RD_CANDIDATES` мод с наименьшей суммой |orig-pred|
/// (при равенстве — младшая мода; полный порядок детерминирован).
fn preselect_modes<const N: usize>(
    sads: &[(u8, u64)], // (мода, SAD) в порядке возрастания номера моды
) -> [u8; N] {
    let mut order: Vec<(u64, u8)> = sads.iter().map(|&(m, s)| (s, m)).collect();
    order.sort_unstable();
    let mut out = [0u8; N];
    for (slot, &(_, m)) in out.iter_mut().zip(order.iter()) {
        *slot = m;
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn choose_mode_with_rate(
    orig: &[i32; 64],
    b: &Border,
    cfl_luma: Option<&[i32; 64]>,
    qmat: &[u16; 64],
    lambda: f32,
    max_mode: u8,
    ac_bias: f32,
    coeff_rate: fn(&[i32; 64]) -> u32,
) -> (u8, [i32; 64], [i32; 64], f32) {
    // Линейность DCT: F(orig - pred) = F(orig) - F(pred). Спектр источника
    // считается один раз; спектры структурных предсказаний (DC/V/H) —
    // аналитически за O(N). Полный DCT остаётся только у TM/D45/D135.
    let mut spatial = [0f32; 64];
    for i in 0..64 {
        spatial[i] = orig[i] as f32;
    }
    let mut freq_orig = [0f32; 64];
    fdct8x8(&spatial, &mut freq_orig);
    let mut freq_pred = [0f32; 64];
    let mut freq_res = [0f32; 64];

    // SAD-предотбор: полный RD дорог (DCT на моду), а явно плохие моды
    // отсеиваются дешёвой пиксельной метрикой.
    let mut sads: Vec<(u8, u64)> = Vec::with_capacity(usize::from(max_mode));
    let mut preds = [[0i32; 64]; N_MODES_V7 as usize];
    for &mode in ENCODE_MODES_V7 {
        if mode >= max_mode {
            continue;
        }
        let pred = predict_block(b, mode);
        let sad: u64 = orig
            .iter()
            .zip(pred.iter())
            .map(|(&o, &p)| u64::from(o.abs_diff(p)))
            .sum();
        preds[usize::from(mode)] = pred;
        sads.push((mode, sad));
    }
    if let Some(luma) = cfl_luma {
        let dc = predict_block(b, MODE_DC)[0];
        let mode = cfl_candidate_mode(orig, luma, dc);
        if mode < max_mode {
            let pred = predict_cfl(luma, dc, mode);
            let sad = orig
                .iter()
                .zip(pred.iter())
                .map(|(&o, &p)| u64::from(o.abs_diff(p)))
                .sum();
            preds[usize::from(mode)] = pred;
            sads.push((mode, sad));
        }
    }
    let candidates = preselect_modes::<RD_CANDIDATES>(&sads);
    let n_candidates = sads.len().min(RD_CANDIDATES);

    let mut best: Option<(u8, [i32; 64], [i32; 64], f32)> = None;
    for &mode in &candidates[..n_candidates] {
        let pred = preds[usize::from(mode)];
        match mode {
            MODE_DC => fdct8x8_const(pred[0] as f32, &mut freq_pred),
            MODE_V => {
                let mut row = [0f32; 8];
                for (i, r) in row.iter_mut().enumerate() {
                    *r = pred[i] as f32;
                }
                fdct8x8_rows(&row, &mut freq_pred);
            }
            MODE_H => {
                let mut col = [0f32; 8];
                for (j, c) in col.iter_mut().enumerate() {
                    *c = pred[j * 8] as f32;
                }
                fdct8x8_cols(&col, &mut freq_pred);
            }
            _ => {
                for i in 0..64 {
                    spatial[i] = pred[i] as f32;
                }
                fdct8x8(&spatial, &mut freq_pred);
            }
        }
        for i in 0..64 {
            freq_res[i] = freq_orig[i] - freq_pred[i];
        }
        let (quantized, distortion) = quantize_freq(&freq_res, qmat, ac_bias);
        let cost = distortion + lambda * coeff_rate(&quantized) as f32;
        let better = match &best {
            Some((_, _, _, c)) => cost < *c,
            None => true,
        };
        if better {
            best = Some((mode, pred, quantized, cost));
        }
    }
    best.expect("моды всегда есть")
}

/// Выбор моды: минимум полной RD-стоимости `D + λ·R`, где D — SSE ошибки
/// квантования в DCT-домене (базис ортонормирован, равно SSE в пикселях),
/// R — legacy-оценка битовой стоимости токенов. При равенстве — младшая мода.
/// Сохранён отдельно, чтобы encoder decisions v1–v6 не менялись.
fn choose_mode(
    orig: &[i32; 64],
    b: &Border,
    cfl_luma: Option<&[i32; 64]>,
    qmat: &[u16; 64],
    lambda: f32,
    max_mode: u8,
    ac_bias: f32,
) -> (u8, [i32; 64], [i32; 64], f32) {
    choose_mode_with_rate(
        orig, b, cfl_luma, qmat, lambda, max_mode, ac_bias, coeff_cost,
    )
}

fn choose_mode_v7(
    orig: &[i32; 64],
    b: &Border,
    cfl_luma: Option<&[i32; 64]>,
    qmat: &[u16; 64],
    lambda: f32,
    max_mode: u8,
    ac_bias: f32,
) -> (u8, [i32; 64], [i32; 64], f32) {
    choose_mode_with_rate(
        orig, b, cfl_luma, qmat, lambda, max_mode, ac_bias, coeff_cost,
    )
}

/// Квантование спектра остатка по `qmat` с dead-zone `ac_bias` для AC.
/// Возвращает квантованный блок и SSE ошибки квантования в DCT-домене.
fn quantize_freq(freq: &[f32; 64], qmat: &[u16; 64], ac_bias: f32) -> ([i32; 64], f32) {
    let mut quantized = [0i32; 64];
    let mut distortion = 0f32;
    for (i, q) in quantized.iter_mut().enumerate() {
        let step = f32::from(qmat[i]);
        let t = freq[i] / step;
        let bias = if i == 0 { 0.5 } else { ac_bias };
        let magnitude = (t.abs() + bias).floor() as i32;
        *q = if t < 0.0 { -magnitude } else { magnitude };
        let err = freq[i] - *q as f32 * step;
        distortion += err * err;
    }
    (quantized, distortion)
}

/// Лагранжиан плоскости из среднего шага квантования.
fn plane_lambda(qmat: &[u16; 64]) -> f32 {
    let mean: f32 = qmat.iter().map(|&q| f32::from(q)).sum::<f32>() / 64.0;
    LAMBDA_SCALE * mean * mean
}

/// DCT остатка `orig - pred` и квантование по `qmat` с dead-zone `ac_bias`
/// для AC. Возвращает квантованный блок и SSE ошибки квантования в DCT-домене.
fn quantize_residual(
    orig: &[i32; 64],
    pred: &[i32; 64],
    qmat: &[u16; 64],
    ac_bias: f32,
) -> ([i32; 64], f32) {
    let mut residual = [0f32; 64];
    for i in 0..64 {
        residual[i] = (orig[i] - pred[i]) as f32;
    }
    let mut freq = [0f32; 64];
    fdct8x8(&residual, &mut freq);
    let mut quantized = [0i32; 64];
    let mut distortion = 0f32;
    for (i, q) in quantized.iter_mut().enumerate() {
        let step = f32::from(qmat[i]);
        let t = freq[i] / step;
        let bias = if i == 0 { 0.5 } else { ac_bias };
        let magnitude = (t.abs() + bias).floor() as i32;
        *q = if t < 0.0 { -magnitude } else { magnitude };
        let err = freq[i] - *q as f32 * step;
        distortion += err * err;
    }
    (quantized, distortion)
}

/// Грубая оценка битовой стоимости блока: на каждый ненулевой коэффициент —
/// константа за run/level-токены плюс длина мантиссы; нулевые хвосты бесплатны.
fn legacy_coeff_cost<const LEN: usize>(quantized: &[i32; LEN], scan: &[usize; LEN]) -> u32 {
    let mut cost = 4u32; // DC-токен + EOB
    let dc = quantized[0].unsigned_abs();
    cost += 2 * (32 - dc.leading_zeros());
    for pos in 1..LEN {
        let v = quantized[scan[pos]].unsigned_abs();
        if v != 0 {
            cost += 6 + 2 * (32 - v.leading_zeros());
        }
    }
    cost
}

fn coeff_cost(quantized: &[i32; 64]) -> u32 {
    legacy_coeff_cost(quantized, &ZIGZAG)
}

/// Альтернативы DCT_DCT, которые reference encoder рассматривает в v7.4.
/// Отдельный список позволяет A/B-отсечение без изменения decoder wire-set.
const ENCODE_TXS_V7: &[u8] = &[TX_ADST_DCT, TX_DCT_ADST, TX_ADST_ADST];
const TX_COST_BITS: u32 = 2;
/// Transform switch должен давать почти ту же ошибку, а не просто более
/// разреженный спектр: общая λ переоценивает грубую coeff-cost для новых базисов.
const TX_SEARCH_LAMBDA_SCALE: f32 = 0.0;
/// Bounded trellis uses the real transform-domain SSE but a deliberately
/// conservative fraction of plane λ because token costs are estimated.
const TRELLIS_LAMBDA_SCALE: f32 = 0.055;

#[inline]
fn tx_rate_extra_bits(tx: u8) -> u32 {
    match tx {
        TX_DCT_DCT => 0,
        TX_ADST_DCT | TX_DCT_ADST => 2,
        TX_ADST_ADST => 3,
        _ => unreachable!("transform ID checked by caller"),
    }
}

/// Функция ошибки квантования: параметр общего RD-ядра. v7 передаёт
/// `squared_quant_error` (реконструкция `level·step`), v8 — вариант с
/// нормативным AC-смещением реконструкции (`lossy::v8`). Указатель на
/// функцию сохраняет побайтовую идентичность замороженного v7: те же
/// f32-операции в том же порядке.
type QuantErrFn = fn(f32, f32, usize, i32) -> f32;

fn quantize_freq_tx<const LEN: usize>(
    freq: &[f32; LEN],
    qmat: &[u16; LEN],
    ac_bias: f32,
    quant_err: QuantErrFn,
) -> ([i32; LEN], f32) {
    let mut quantized = [0i32; LEN];
    let mut distortion = 0f32;
    for (i, q) in quantized.iter_mut().enumerate() {
        let step = f32::from(qmat[i]);
        let scaled = freq[i] / step;
        let bias = if i == 0 { 0.5 } else { ac_bias };
        let magnitude = (scaled.abs() + bias).floor() as i32;
        *q = if scaled < 0.0 { -magnitude } else { magnitude };
        distortion += quant_err(freq[i], step, i, *q);
    }
    (quantized, distortion)
}

/// Ошибка реконструкции v1–v7: `value − level·step` (позиция не участвует).
#[inline]
fn squared_quant_error(value: f32, step: f32, _index: usize, level: i32) -> f32 {
    let error = value - level as f32 * step;
    error * error
}

#[inline]
fn dc_rate_estimate(level: i32) -> u32 {
    let (_, _, raw_bits) = tokenize(zigzag(level));
    3 + raw_bits
}

#[inline]
fn ac_level_rate_estimate(magnitude: u32) -> u32 {
    let (_, _, raw_bits) = tokenize(magnitude - 1);
    4 + raw_bits // model symbol + sign
}

#[inline]
fn ac_event_rate_estimate(run: usize, magnitude: u32) -> u32 {
    let (_, _, run_raw_bits) = tokenize(run as u32);
    1 + 3 + run_raw_bits + ac_level_rate_estimate(magnitude)
}

fn trellis_rdoq<const LEN: usize>(
    freq: &[f32; LEN],
    qmat: &[u16; LEN],
    mut quantized: [i32; LEN],
    lambda: f32,
    scan: &[usize; LEN],
    quant_err: QuantErrFn,
) -> ([i32; LEN], f32) {
    let rd_lambda = lambda * TRELLIS_LAMBDA_SCALE;

    // First refine magnitudes without changing the non-zero map.
    for (index, level) in quantized.iter_mut().enumerate() {
        let current = *level;
        if index != 0 && current == 0 {
            continue;
        }
        let step = f32::from(qmat[index]);
        let nearest = (freq[index].abs() / step).round() as i32;
        let sign = if freq[index] < 0.0 { -1 } else { 1 };
        let current_mag = current.unsigned_abs() as i32;
        let candidates = [
            nearest.saturating_sub(1),
            nearest,
            nearest.saturating_add(1),
        ];
        let mut best_level = current;
        let mut best_cost = quant_err(freq[index], step, index, current)
            + rd_lambda
                * if index == 0 {
                    dc_rate_estimate(current) as f32
                } else {
                    ac_level_rate_estimate(current.unsigned_abs()) as f32
                };
        for (candidate_index, magnitude) in candidates.into_iter().enumerate() {
            if magnitude == current_mag
                || candidates[..candidate_index].contains(&magnitude)
                || (index != 0 && magnitude == 0)
            {
                continue;
            }
            let candidate = sign * magnitude;
            let rate = if index == 0 {
                dc_rate_estimate(candidate)
            } else {
                ac_level_rate_estimate(magnitude as u32)
            };
            let cost = quant_err(freq[index], step, index, candidate) + rd_lambda * rate as f32;
            if cost < best_cost {
                best_cost = cost;
                best_level = candidate;
            }
        }
        *level = best_level;
    }

    // Then prune AC nodes in reverse scan order. Removing a node merges its
    // two run edges, so this captures run/EOB coupling without O(N²) search.
    const NO_NODE: u16 = u16::MAX;
    #[derive(Clone, Copy)]
    struct TrellisNode {
        pos: u16,
        previous: u16,
        next: u16,
    }
    debug_assert!(u16::try_from(LEN).is_ok());
    let mut nodes = [TrellisNode {
        pos: 0,
        previous: NO_NODE,
        next: NO_NODE,
    }; LEN];
    let mut count = 0usize;
    for pos in 1..LEN {
        if quantized[scan[pos]] == 0 {
            continue;
        }
        if count != 0 {
            nodes[count - 1].next = count as u16;
        }
        nodes[count] = TrellisNode {
            pos: pos as u16,
            previous: if count == 0 {
                NO_NODE
            } else {
                (count - 1) as u16
            },
            next: NO_NODE,
        };
        count += 1;
    }

    for node in (0..count).rev() {
        let pos = usize::from(nodes[node].pos);
        let index = scan[pos];
        let prev_node = nodes[node].previous;
        let next_node = nodes[node].next;
        let prev_pos = if prev_node == NO_NODE {
            0
        } else {
            usize::from(nodes[usize::from(prev_node)].pos)
        };
        let current_rate =
            ac_event_rate_estimate(pos - prev_pos - 1, quantized[index].unsigned_abs());
        let saved_rate = if next_node == NO_NODE {
            current_rate as i32
        } else {
            let next_pos = usize::from(nodes[usize::from(next_node)].pos);
            let next_index = scan[next_pos];
            let old_next =
                ac_event_rate_estimate(next_pos - pos - 1, quantized[next_index].unsigned_abs());
            let merged_next = ac_event_rate_estimate(
                next_pos - prev_pos - 1,
                quantized[next_index].unsigned_abs(),
            );
            current_rate as i32 + old_next as i32 - merged_next as i32
        };
        let step = f32::from(qmat[index]);
        let distortion_increase =
            freq[index] * freq[index] - quant_err(freq[index], step, index, quantized[index]);
        if saved_rate > 0 && distortion_increase < rd_lambda * saved_rate as f32 {
            quantized[index] = 0;
            if prev_node != NO_NODE {
                nodes[usize::from(prev_node)].next = next_node;
            }
            if next_node != NO_NODE {
                nodes[usize::from(next_node)].previous = prev_node;
            }
        }
    }

    let distortion = quantized
        .iter()
        .enumerate()
        .map(|(index, &level)| quant_err(freq[index], f32::from(qmat[index]), index, level))
        .sum();
    (quantized, distortion)
}

#[allow(clippy::too_many_arguments)]
fn choose_transform<const LEN: usize>(
    orig: &[i32; LEN],
    pred: &[i32; LEN],
    qmat: &[u16; LEN],
    lambda: f32,
    ac_bias: f32,
    baseline_quantized: [i32; LEN],
    baseline_cost: f32,
    forward: fn(&[f32; LEN], &mut [f32; LEN], u8),
    scan_for_tx: fn(u8) -> &'static [usize; LEN],
    quant_err: QuantErrFn,
) -> (u8, [i32; LEN], f32) {
    let mut residual = [0f32; LEN];
    for i in 0..LEN {
        residual[i] = (orig[i] - pred[i]) as f32;
    }
    let base_rate = legacy_coeff_cost(&baseline_quantized, scan_for_tx(TX_DCT_DCT));
    let base_distortion = baseline_cost - lambda * base_rate as f32;
    let mut best = (
        TX_DCT_DCT,
        baseline_quantized,
        baseline_cost,
        base_distortion + lambda * TX_SEARCH_LAMBDA_SCALE * base_rate as f32,
    );
    let mut freq = [0f32; LEN];
    let mut best_freq = [0f32; LEN];
    for &tx in ENCODE_TXS_V7 {
        forward(&residual, &mut freq, tx);
        let (quantized, distortion) = quantize_freq_tx(&freq, qmat, ac_bias, quant_err);
        let rate = legacy_coeff_cost(&quantized, scan_for_tx(tx)) + tx_rate_extra_bits(tx);
        let search_cost = distortion + lambda * TX_SEARCH_LAMBDA_SCALE * rate as f32;
        if search_cost < best.3 {
            let cost = distortion + lambda * rate as f32;
            best = (tx, quantized, cost, search_cost);
            best_freq.copy_from_slice(&freq);
        }
    }
    if best.0 == TX_DCT_DCT {
        forward(&residual, &mut freq, best.0);
    } else {
        freq = best_freq;
    }
    let scan = scan_for_tx(best.0);
    let (quantized, distortion) = trellis_rdoq(&freq, qmat, best.1, lambda, scan, quant_err);
    let rate = legacy_coeff_cost(&quantized, scan) + tx_rate_extra_bits(best.0);
    (best.0, quantized, distortion + lambda * rate as f32)
}

// --- общее кодирование коэффициентов ------------------------------------------

/// Кодирует квантованный блок (DC-токен + run/level AC) в потоки.
fn encode_coeffs(
    quantized: &[i32; 64],
    dc_token: i32,
    syms: &mut Vec<(u8, u8)>,
    raw: &mut BitWriter,
) {
    let (sym, bits, n_bits) = tokenize(zigzag(dc_token));
    syms.push((CTX_DC, sym));
    write_raw(raw, bits, n_bits);

    let mut pos = 1usize;
    while pos < 64 {
        let run_start = pos;
        let mut run = 0usize;
        while pos < 64 && quantized[ZIGZAG[pos]] == 0 {
            run += 1;
            pos += 1;
        }
        if pos == 64 {
            syms.push((run_ctx(run_start), EOB_SYM));
            break;
        }
        let (rsym, rbits, rn) = tokenize(run as u32);
        syms.push((run_ctx(run_start), rsym));
        write_raw(raw, rbits, rn);

        let level = quantized[ZIGZAG[pos]];
        let (lsym, lbits, ln) = tokenize(level.unsigned_abs() - 1);
        syms.push((level_ctx(pos), lsym));
        write_raw(raw, lbits, ln);
        raw.write(u32::from(level < 0), 1);
        pos += 1;
    }
}

/// Декодирует квантованный блок; возвращает DC-токен.
fn decode_coeffs(
    section: &Section<'_>,
    dec: &mut RansDecoder<'_>,
    raw: &mut BitReader<'_>,
    qmat: &[u16; 64],
    freq: &mut [f32; 64],
) -> Result<i32, DecodeError> {
    freq.fill(0.0);
    let dc_sym = dec.get(&section.tables[usize::from(CTX_DC)])?;
    let dc_token = unzigzag(detokenize(dc_sym, raw)?);

    let mut pos = 1usize;
    while pos < 64 {
        let rsym = dec.get(&section.tables[usize::from(run_ctx(pos))])?;
        if rsym == EOB_SYM {
            break;
        }
        let run = detokenize(rsym, raw)? as usize;
        let new_pos = pos
            .checked_add(run)
            .ok_or(DecodeError::Corrupt("dct: run overflow"))?;
        if new_pos >= 64 {
            return Err(DecodeError::Corrupt("dct: позиция AC вне блока"));
        }
        pos = new_pos;
        let lsym = dec.get(&section.tables[usize::from(level_ctx(pos))])?;
        let magnitude = detokenize(lsym, raw)?.wrapping_add(1) as i32;
        let sign = raw.read(1)?;
        let level = if sign == 1 { -magnitude } else { magnitude };
        freq[ZIGZAG[pos]] = level as f32 * f32::from(qmat[ZIGZAG[pos]]);
        pos += 1;
    }
    Ok(dc_token)
}

// --- v3/v2: intra-предикция + DCT остатка --------------------------------------

/// Кодирует тайл-плоскость битстрима v1 (без intra-предикции, DC-цепочка).
pub fn encode_tile_plane_v1(
    buf: &[i16],
    w: usize,
    h: usize,
    qmat: &[u16; 64],
    syms: &mut Vec<(u8, u8)>,
    raw: &mut BitWriter,
) {
    debug_assert_eq!(buf.len(), w * h);
    let blocks_x = w.div_ceil(8);
    let blocks_y = h.div_ceil(8);
    let zero_pred = [128i32; 64];
    let mut prev_dc: i32 = 0;
    for by in 0..blocks_y {
        for bx in 0..blocks_x {
            let orig = gather_block_i32(buf, w, h, bx, by);
            let (quantized, _) = quantize_residual(&orig, &zero_pred, qmat, AC_BIAS);
            let dc_token = quantized[0] - prev_dc;
            prev_dc = quantized[0];
            encode_coeffs(&quantized, dc_token, syms, raw);
        }
    }
}

/// Кодирует тайл-плоскость (битстрим v3). Ведёт реконструкцию для предикции.
/// Dead-zone AC адаптивен по активности блока (свобода кодера, §8).
pub fn encode_tile_plane(
    buf: &[i16],
    w: usize,
    h: usize,
    qmat: &[u16; 64],
    syms: &mut Vec<(u8, u8)>,
    raw: &mut BitWriter,
) {
    encode_tile_plane_with_modes(buf, w, h, qmat, syms, raw, N_MODES_V3, true);
}

/// Кодирует тайл-плоскость битстрима v2 (моды DC/V/H/TM). Dead-zone
/// фиксированный: путь заморожен ради воспроизводимости v2 golden-векторов.
pub fn encode_tile_plane_v2(
    buf: &[i16],
    w: usize,
    h: usize,
    qmat: &[u16; 64],
    syms: &mut Vec<(u8, u8)>,
    raw: &mut BitWriter,
) {
    encode_tile_plane_with_modes(buf, w, h, qmat, syms, raw, N_MODES_V2, false);
}

#[allow(clippy::too_many_arguments)]
fn encode_tile_plane_with_modes(
    buf: &[i16],
    w: usize,
    h: usize,
    qmat: &[u16; 64],
    syms: &mut Vec<(u8, u8)>,
    raw: &mut BitWriter,
    max_mode: u8,
    adaptive_quant: bool,
) {
    debug_assert_eq!(buf.len(), w * h);
    let blocks_x = w.div_ceil(8);
    let blocks_y = h.div_ceil(8);
    let lambda = plane_lambda(qmat);
    let mut recon = vec![0i16; w * h];
    let mut freq = [0f32; 64];
    let mut spatial = [0f32; 64];
    for by in 0..blocks_y {
        for bx in 0..blocks_x {
            let orig = gather_block_i32(buf, w, h, bx, by);
            let ac_bias = if adaptive_quant {
                adaptive_ac_bias(block_activity(&orig))
            } else {
                AC_BIAS
            };
            let b = border(&recon, w, h, bx, by);
            let (mode, pred, quantized, _) =
                choose_mode(&orig, &b, None, qmat, lambda, max_mode, ac_bias);
            syms.push((CTX_MODE, mode));
            encode_coeffs(&quantized, quantized[0], syms, raw);

            // Реконструкция — ровно как в декодере (общая арифметика).
            for i in 0..64 {
                freq[i] = quantized[i] as f32 * f32::from(qmat[i]);
            }
            idct8x8(&freq, &mut spatial);
            store_block(&mut recon, w, h, bx, by, &spatial, &pred);
        }
    }
}

/// Декодирует тайл-плоскость v2/v3 (отличие — число допустимых мод).
/// Возвращает буфер отсчётов 0..=255.
fn decode_tile_plane_pred(
    section: &Section<'_>,
    dec: &mut RansDecoder<'_>,
    raw: &mut BitReader<'_>,
    w: usize,
    h: usize,
    qmat: &[u16; 64],
    n_modes: u8,
) -> Result<Vec<i16>, DecodeError> {
    let blocks_x = w.div_ceil(8);
    let blocks_y = h.div_ceil(8);
    let mut recon = vec![0i16; w * h];
    let mut freq = [0f32; 64];
    let mut spatial = [0f32; 64];
    for by in 0..blocks_y {
        for bx in 0..blocks_x {
            let mode_sym = dec.get(&section.tables[usize::from(CTX_MODE)])?;
            if mode_sym >= n_modes {
                return Err(DecodeError::Corrupt("dct: неизвестная мода предикции"));
            }
            let b = border(&recon, w, h, bx, by);
            let pred = predict_block(&b, mode_sym);

            let dc_token = decode_coeffs(section, dec, raw, qmat, &mut freq)?;
            freq[0] = dc_token as f32 * f32::from(qmat[0]);
            idct8x8(&freq, &mut spatial);
            store_block(&mut recon, w, h, bx, by, &spatial, &pred);
        }
    }
    Ok(recon)
}

/// Декодирует тайл-плоскость v3 (6 мод).
pub fn decode_tile_plane(
    section: &Section<'_>,
    dec: &mut RansDecoder<'_>,
    raw: &mut BitReader<'_>,
    w: usize,
    h: usize,
    qmat: &[u16; 64],
) -> Result<Vec<i16>, DecodeError> {
    decode_tile_plane_pred(section, dec, raw, w, h, qmat, N_MODES_V3)
}

/// Декодирует тайл-плоскость битстрима v2 (4 моды; сохраняется навсегда).
pub fn decode_tile_plane_v2(
    section: &Section<'_>,
    dec: &mut RansDecoder<'_>,
    raw: &mut BitReader<'_>,
    w: usize,
    h: usize,
    qmat: &[u16; 64],
) -> Result<Vec<i16>, DecodeError> {
    decode_tile_plane_pred(section, dec, raw, w, h, qmat, N_MODES_V2)
}

/// Пишет блок `остаток + предсказание` в реконструкцию (кламп 0..=255).
fn store_block(
    recon: &mut [i16],
    w: usize,
    h: usize,
    bx: usize,
    by: usize,
    residual: &[f32; 64],
    pred: &[i32; 64],
) {
    for y in 0..8 {
        let sy = by * 8 + y;
        if sy >= h {
            break;
        }
        for x in 0..8 {
            let sx = bx * 8 + x;
            if sx >= w {
                break;
            }
            let v = (residual[y * 8 + x] + pred[y * 8 + x] as f32)
                .round()
                .clamp(0.0, 255.0);
            recon[sy * w + sx] = v as i16;
        }
    }
}

// --- v5: суперблоки 16×16 (split-решение на суперблок) --------------------------
//
// Плоскость сканируется суперблоками 16×16 row-major. На каждый суперблок
// сигналится split-решение (CTX_SPLIT): 0 — суперблок кодируется целиком
// (одна мода + DCT 16×16 по матрице `quant_matrix16`), 1 — четыре блока 8×8
// row-major, каждый ровно как в v3. Подблоки, полностью лежащие вне
// плоскости (правый/нижний край), не кодируются. Гладкие зоны (небо, кожа,
// фон) получают одну моду и один DC вместо четырёх — главный резерв
// плотности v5.

/// Суперблок кодируется целиком (16×16).
const SPLIT_WHOLE: u8 = 0;
/// Суперблок расщеплён на четыре 8×8.
const SPLIT_QUAD: u8 = 1;

/// Битовая стоимость сигналинга моды (оценка для RD; свобода кодера).
const MODE_COST_BITS: u32 = 3;

#[inline]
fn run_ctx16(pos: usize) -> u8 {
    if pos <= LOW_BAND_END16 {
        CTX_RUN_LOW
    } else {
        CTX_RUN_HIGH
    }
}

#[inline]
fn level_ctx16(pos: usize) -> u8 {
    if pos <= LOW_BAND_END16 {
        CTX_LEVEL_LOW
    } else {
        CTX_LEVEL_HIGH
    }
}

/// Собирает блок 16×16 с репликацией краёв.
fn gather_block16_i32(buf: &[i16], w: usize, h: usize, sbx: usize, sby: usize) -> [i32; 256] {
    let mut block = [0i32; 256];
    for y in 0..16 {
        let sy = (sby * 16 + y).min(h - 1);
        for x in 0..16 {
            let sx = (sbx * 16 + x).min(w - 1);
            block[y * 16 + x] = i32::from(buf[sy * w + sx]);
        }
    }
    block
}

/// Активность блока 16×16 (MAD — масштабонезависима, пороги AQ общие).
fn block_activity16(block: &[i32; 256]) -> f32 {
    let mean = block.iter().sum::<i32>() / 256;
    let mad: i32 = block.iter().map(|&v| (v - mean).abs()).sum();
    mad as f32 / 256.0
}

/// MAD одного квадранта 8×8 внутри суперблока (индекс 0..=3 row-major).
fn quadrant_activity(block: &[i32; 256], q: usize) -> f32 {
    let (x0, y0) = ((q % 2) * 8, (q / 2) * 8);
    let mut sum = 0i32;
    let mut mad = 0i32;
    for y in 0..8 {
        for x in 0..8 {
            let v = block[(y0 + y) * 16 + x0 + x];
            sum += v;
        }
    }
    let mean = sum / 64;
    for y in 0..8 {
        for x in 0..8 {
            let v = block[(y0 + y) * 16 + x0 + x];
            mad += (v - mean).abs();
        }
    }
    mad as f32 / 64.0
}

/// Порог контраста квадрантов для форсированного расщепления (MAD).
const SPLIT_CONTRAST: f32 = 12.0;

/// Быстрый предвыбор split-решения (свобода кодера, §8).
///
/// - `Some(SPLIT_WHOLE)` — равномерно гладкий суперблок (все квадранты
///   с активностью ≤ `AQ_ACT_LO`): RD почти всегда выбирает 16×16.
/// - `Some(SPLIT_QUAD)` — гетерогенный суперблок (контраст активностей
///   квадрантов ≥ `SPLIT_CONTRAST`): раздельные моды 8×8 окупаются.
/// - `None` — пограничный случай, полный RD.
///
/// Отклонённые варианты (измерено на корпусе q=75): QUAD при одном
/// насыщенном квадранте — +2% размера; QUAD при равномерной насыщенности
/// (все квадранты ≥ `AQ_ACT_HI`) — +1.6% на шуме: там все AC умирают
/// и один DC 16×16 дешевле четырёх 8×8, RD верно выбирает WHOLE.
fn split_hint(orig16: &[i32; 256]) -> Option<u8> {
    let mut min_a = f32::INFINITY;
    let mut max_a = 0f32;
    for q in 0..4 {
        let a = quadrant_activity(orig16, q);
        min_a = min_a.min(a);
        max_a = max_a.max(a);
    }
    if max_a <= AQ_ACT_LO && block_activity16(orig16) <= AQ_ACT_LO {
        return Some(SPLIT_WHOLE);
    }
    if max_a - min_a >= SPLIT_CONTRAST {
        return Some(SPLIT_QUAD);
    }
    // Равномерно насыщенный (шум/плотная текстура): сильное квантование
    // убивает почти все AC, один DC 16×16 дешевле четырёх 8×8 — RD в этих
    // блоках стабильно выбирает WHOLE (проверено предыдущей веткой: форс
    // QUAD давал +1.6% на шуме).
    if min_a >= AQ_ACT_HI {
        return Some(SPLIT_WHOLE);
    }
    None
}

/// Граница суперблока: верхняя строка (расширенная вправо на 16), левый
/// столбец, угол — та же модель, что у 8×8 (§7.1), масштаб 16.
struct Border16 {
    above: [i32; 32],
    left: [i32; 16],
    corner: i32,
}

fn border16(recon: &[i16], w: usize, h: usize, sbx: usize, sby: usize) -> Border16 {
    let (px, py) = (sbx * 16, sby * 16);
    let mut above = [128i32; 32];
    let mut left = [128i32; 16];
    let mut corner = 128i32;
    if py > 0 {
        let ay = py - 1;
        for (i, a) in above.iter_mut().enumerate() {
            *a = i32::from(recon[ay * w + (px + i).min(w - 1)]);
        }
    }
    if px > 0 {
        let ax = px - 1;
        for (i, l) in left.iter_mut().enumerate() {
            *l = i32::from(recon[(py + i).min(h - 1) * w + ax]);
        }
    }
    if px > 0 && py > 0 {
        corner = i32::from(recon[(py - 1) * w + px - 1]);
    }
    Border16 {
        above,
        left,
        corner,
    }
}

/// Предсказание суперблока — формулы 8×8 (§7.1) в масштабе 16.
fn predict_block16(b: &Border16, mode: u8) -> [i32; 256] {
    let mut out = [0i32; 256];
    match mode {
        MODE_V => {
            for y in 0..16 {
                out[y * 16..y * 16 + 16].copy_from_slice(&b.above[0..16]);
            }
        }
        MODE_H => {
            for y in 0..16 {
                out[y * 16..y * 16 + 16].copy_from_slice(&[b.left[y]; 16]);
            }
        }
        MODE_TM => {
            for y in 0..16 {
                for x in 0..16 {
                    out[y * 16 + x] = (b.left[y] + b.above[x] - b.corner).clamp(0, 255);
                }
            }
        }
        MODE_D45 => {
            for y in 0..16 {
                for x in 0..16 {
                    let s = x + y;
                    let (a0, a1, a2) = (b.above[s], b.above[s + 1], b.above[(s + 2).min(31)]);
                    out[y * 16 + x] = (a0 + 2 * a1 + a2 + 2) >> 2;
                }
            }
        }
        MODE_D135 => {
            let mut line = [0i32; 33];
            for (j, slot) in line[0..16].iter_mut().enumerate() {
                *slot = b.left[15 - j];
            }
            line[16] = b.corner;
            line[17..33].copy_from_slice(&b.above[0..16]);
            for y in 0..16 {
                for x in 0..16 {
                    let d = 16 + x - y; // 1..=31
                    out[y * 16 + x] = (line[d - 1] + 2 * line[d] + line[d + 1] + 2) >> 2;
                }
            }
        }
        MODE_SMOOTH => {
            for y in 0..16 {
                for x in 0..16 {
                    out[y * 16 + x] = smooth_sample(&b.above, &b.left, x, y);
                }
            }
        }
        _ => {
            let sum: i32 = b.above[0..16].iter().sum::<i32>() + b.left.iter().sum::<i32>();
            let dc = (sum + 16) >> 5;
            out.fill(dc);
        }
    }
    out
}

/// Оценка битовой стоимости блока 16×16 (модель `coeff_cost`).
fn coeff_cost16(quantized: &[i32; 256]) -> u32 {
    legacy_coeff_cost(quantized, &ZIGZAG16)
}

#[allow(clippy::too_many_arguments)]
fn choose_mode16_with_rate(
    orig: &[i32; 256],
    b: &Border16,
    cfl_luma: Option<&[i32; 256]>,
    qmat16: &[u16; 256],
    lambda: f32,
    max_mode: u8,
    ac_bias: f32,
    coeff_rate: fn(&[i32; 256]) -> u32,
) -> (u8, [i32; 256], [i32; 256], f32) {
    let mut spatial = [0f32; 256];
    for i in 0..256 {
        spatial[i] = orig[i] as f32;
    }
    let mut freq_orig = [0f32; 256];
    fdct16(&spatial, &mut freq_orig);
    let mut freq_pred = [0f32; 256];
    let mut freq_res = [0f32; 256];

    // SAD-предотбор (как в 8×8): полный RD только для лучших кандидатов.
    // Кандидатов меньше, чем у 8×8: DCT 16×16 вчетверо дороже, а моды
    // на гладких суперблоках почти эквивалентны (измерено: топ-3 нейтрален
    // по размеру корпуса). Предсказания — на стеке (6 КБ): heap-аллокация
    // на каждый суперблок была заметна в профиле encode.
    let mut sads: Vec<(u8, u64)> = Vec::with_capacity(usize::from(max_mode));
    let mut preds = [[0i32; 256]; N_MODES_V7 as usize];
    for &mode in ENCODE_MODES_V7 {
        if mode >= max_mode {
            continue;
        }
        let pred = predict_block16(b, mode);
        let sad: u64 = orig
            .iter()
            .zip(pred.iter())
            .map(|(&o, &p)| u64::from(o.abs_diff(p)))
            .sum();
        preds[usize::from(mode)] = pred;
        sads.push((mode, sad));
    }
    if let Some(luma) = cfl_luma {
        let dc = predict_block16(b, MODE_DC)[0];
        let mode = cfl_candidate_mode(orig, luma, dc);
        if mode < max_mode {
            let pred = predict_cfl(luma, dc, mode);
            let sad = orig
                .iter()
                .zip(pred.iter())
                .map(|(&o, &p)| u64::from(o.abs_diff(p)))
                .sum();
            preds[usize::from(mode)] = pred;
            sads.push((mode, sad));
        }
    }
    let candidates = preselect_modes::<RD_CANDIDATES16>(&sads);

    let mut best: Option<(u8, [i32; 256], [i32; 256], f32)> = None;
    for &mode in &candidates[..RD_CANDIDATES16] {
        let pred = &preds[usize::from(mode)];
        match mode {
            MODE_DC => fdct16_const(pred[0] as f32, &mut freq_pred),
            MODE_V => {
                let mut row = [0f32; 16];
                for (i, r) in row.iter_mut().enumerate() {
                    *r = pred[i] as f32;
                }
                fdct16_rows(&row, &mut freq_pred);
            }
            MODE_H => {
                let mut col = [0f32; 16];
                for (j, c) in col.iter_mut().enumerate() {
                    *c = pred[j * 16] as f32;
                }
                fdct16_cols(&col, &mut freq_pred);
            }
            _ => {
                for i in 0..256 {
                    spatial[i] = pred[i] as f32;
                }
                fdct16(&spatial, &mut freq_pred);
            }
        }
        for i in 0..256 {
            freq_res[i] = freq_orig[i] - freq_pred[i];
        }
        let (quantized, distortion) = quantize_freq16(&freq_res, qmat16, ac_bias);
        let cost = distortion + lambda * coeff_rate(&quantized) as f32;
        let better = match &best {
            Some((_, _, _, c)) => cost < *c,
            None => true,
        };
        if better {
            best = Some((mode, *pred, quantized, cost));
        }
    }
    best.expect("моды всегда есть")
}

/// Выбор моды суперблока для legacy encoder decisions v1–v6.
fn choose_mode16(
    orig: &[i32; 256],
    b: &Border16,
    cfl_luma: Option<&[i32; 256]>,
    qmat16: &[u16; 256],
    lambda: f32,
    max_mode: u8,
    ac_bias: f32,
) -> (u8, [i32; 256], [i32; 256], f32) {
    choose_mode16_with_rate(
        orig,
        b,
        cfl_luma,
        qmat16,
        lambda,
        max_mode,
        ac_bias,
        coeff_cost16,
    )
}

fn choose_mode16_v7(
    orig: &[i32; 256],
    b: &Border16,
    cfl_luma: Option<&[i32; 256]>,
    qmat16: &[u16; 256],
    lambda: f32,
    max_mode: u8,
    ac_bias: f32,
) -> (u8, [i32; 256], [i32; 256], f32) {
    choose_mode16_with_rate(
        orig,
        b,
        cfl_luma,
        qmat16,
        lambda,
        max_mode,
        ac_bias,
        coeff_cost16,
    )
}

/// Квантование спектра 16×16 (аналог `quantize_freq`).
fn quantize_freq16(freq: &[f32; 256], qmat16: &[u16; 256], ac_bias: f32) -> ([i32; 256], f32) {
    let mut quantized = [0i32; 256];
    let mut distortion = 0f32;
    for (i, q) in quantized.iter_mut().enumerate() {
        let step = f32::from(qmat16[i]);
        let t = freq[i] / step;
        let bias = if i == 0 { 0.5 } else { ac_bias };
        let magnitude = (t.abs() + bias).floor() as i32;
        *q = if t < 0.0 { -magnitude } else { magnitude };
        let err = freq[i] - *q as f32 * step;
        distortion += err * err;
    }
    (quantized, distortion)
}

/// Кодирует коэффициенты 16×16 (DC-токен + run/level по `ZIGZAG16`).
fn encode_coeffs16(quantized: &[i32; 256], syms: &mut Vec<(u8, u8)>, raw: &mut BitWriter) {
    let (sym, bits, n_bits) = tokenize(zigzag(quantized[0]));
    syms.push((CTX_DC, sym));
    write_raw(raw, bits, n_bits);

    let mut pos = 1usize;
    while pos < 256 {
        let run_start = pos;
        let mut run = 0usize;
        while pos < 256 && quantized[ZIGZAG16[pos]] == 0 {
            run += 1;
            pos += 1;
        }
        if pos == 256 {
            syms.push((run_ctx16(run_start), EOB_SYM));
            break;
        }
        let (rsym, rbits, rn) = tokenize(run as u32);
        syms.push((run_ctx16(run_start), rsym));
        write_raw(raw, rbits, rn);

        let level = quantized[ZIGZAG16[pos]];
        let (lsym, lbits, ln) = tokenize(level.unsigned_abs() - 1);
        syms.push((level_ctx16(pos), lsym));
        write_raw(raw, lbits, ln);
        raw.write(u32::from(level < 0), 1);
        pos += 1;
    }
}

/// Декодирует коэффициенты 16×16; возвращает DC-токен.
fn decode_coeffs16(
    section: &Section<'_>,
    dec: &mut RansDecoder<'_>,
    raw: &mut BitReader<'_>,
    qmat16: &[u16; 256],
    freq: &mut [f32; 256],
) -> Result<i32, DecodeError> {
    freq.fill(0.0);
    let dc_sym = dec.get(&section.tables[usize::from(CTX_DC)])?;
    let dc_token = unzigzag(detokenize(dc_sym, raw)?);

    let mut pos = 1usize;
    while pos < 256 {
        let rsym = dec.get(&section.tables[usize::from(run_ctx16(pos))])?;
        if rsym == EOB_SYM {
            break;
        }
        let run = detokenize(rsym, raw)? as usize;
        let new_pos = pos
            .checked_add(run)
            .ok_or(DecodeError::Corrupt("dct16: run overflow"))?;
        if new_pos >= 256 {
            return Err(DecodeError::Corrupt("dct16: позиция AC вне блока"));
        }
        pos = new_pos;
        let lsym = dec.get(&section.tables[usize::from(level_ctx16(pos))])?;
        let magnitude = detokenize(lsym, raw)?.wrapping_add(1) as i32;
        let sign = raw.read(1)?;
        let level = if sign == 1 { -magnitude } else { magnitude };
        freq[ZIGZAG16[pos]] = level as f32 * f32::from(qmat16[ZIGZAG16[pos]]);
        pos += 1;
    }
    Ok(dc_token)
}

/// Пишет суперблок `остаток + предсказание` в реконструкцию (кламп 0..=255).
fn store_block16(
    recon: &mut [i16],
    w: usize,
    h: usize,
    sbx: usize,
    sby: usize,
    residual: &[f32; 256],
    pred: &[i32; 256],
) {
    for y in 0..16 {
        let sy = sby * 16 + y;
        if sy >= h {
            break;
        }
        for x in 0..16 {
            let sx = sbx * 16 + x;
            if sx >= w {
                break;
            }
            let v = (residual[y * 16 + x] + pred[y * 16 + x] as f32)
                .round()
                .clamp(0.0, 255.0);
            recon[sy * w + sx] = v as i16;
        }
    }
}

/// Подблоки 8×8 суперблока, пересекающие плоскость (row-major).
fn sub_blocks(sbx: usize, sby: usize, w: usize, h: usize) -> impl Iterator<Item = (usize, usize)> {
    (0..4).filter_map(move |i| {
        let (bx, by) = (sbx * 2 + i % 2, sby * 2 + i / 2);
        (bx * 8 < w && by * 8 < h).then_some((bx, by))
    })
}

/// Результат RD-прогона одного подблока 8×8 (для эмиссии без пересчёта).
struct SubBlock {
    mode: u8,
    tx: u8,
    quantized: [i32; 64],
}

/// RD-прогон блока 8×8 слоя v3 в составе v5: выбирает моду и обновляет
/// реконструкцию. Токены не пишет — эмиссия идёт из кэша (`SubBlock`).
#[allow(clippy::too_many_arguments)]
fn eval_block8(
    buf: &[i16],
    recon: &mut [i16],
    w: usize,
    h: usize,
    bx: usize,
    by: usize,
    qmat: &[u16; 64],
    lambda: f32,
) -> (SubBlock, f32) {
    let orig = gather_block_i32(buf, w, h, bx, by);
    let ac_bias = adaptive_ac_bias(block_activity(&orig));
    let b = border(recon, w, h, bx, by);
    let (mode, pred, quantized, cost) =
        choose_mode(&orig, &b, None, qmat, lambda, N_MODES_V3, ac_bias);
    let mut freq = [0f32; 64];
    let mut spatial = [0f32; 64];
    for i in 0..64 {
        freq[i] = quantized[i] as f32 * f32::from(qmat[i]);
    }
    idct8x8(&freq, &mut spatial);
    store_block(recon, w, h, bx, by, &spatial, &pred);
    (
        SubBlock {
            mode,
            tx: TX_DCT_DCT,
            quantized,
        },
        cost + lambda * MODE_COST_BITS as f32,
    )
}

/// Кодирует тайл-плоскость битстрима v5: RD-выбор целиком/расщепление
/// на каждый суперблок 16×16.
pub fn encode_tile_plane_v5(
    buf: &[i16],
    w: usize,
    h: usize,
    qmat: &[u16; 64],
    syms: &mut Vec<(u8, u8)>,
    raw: &mut BitWriter,
) {
    debug_assert_eq!(buf.len(), w * h);
    let sb_cols = w.div_ceil(16);
    let sb_rows = h.div_ceil(16);
    let qmat16 = quant_matrix16(qmat);
    let lambda = plane_lambda(qmat);
    let mut recon = vec![0i16; w * h];
    let mut subs: Vec<SubBlock> = Vec::with_capacity(4);
    for sby in 0..sb_rows {
        for sbx in 0..sb_cols {
            let orig16 = gather_block16_i32(buf, w, h, sbx, sby);
            let hint = split_hint(&orig16);

            if hint == Some(SPLIT_WHOLE) {
                let ac_bias16 = adaptive_ac_bias(block_activity16(&orig16));
                let b16 = border16(&recon, w, h, sbx, sby);
                let (mode16, pred16, quant16, _) =
                    choose_mode16(&orig16, &b16, None, &qmat16, lambda, N_MODES_V3, ac_bias16);
                syms.push((CTX_SPLIT, SPLIT_WHOLE));
                syms.push((CTX_MODE, mode16));
                encode_coeffs16(&quant16, syms, raw);
                let mut freq = [0f32; 256];
                let mut spatial = [0f32; 256];
                for i in 0..256 {
                    freq[i] = quant16[i] as f32 * f32::from(qmat16[i]);
                }
                idct16(&freq, &mut spatial);
                store_block16(&mut recon, w, h, sbx, sby, &spatial, &pred16);
                continue;
            }
            if hint == Some(SPLIT_QUAD) {
                syms.push((CTX_SPLIT, SPLIT_QUAD));
                for (bx, by) in sub_blocks(sbx, sby, w, h) {
                    let (sub, _) = eval_block8(buf, &mut recon, w, h, bx, by, qmat, lambda);
                    syms.push((CTX_MODE, sub.mode));
                    encode_coeffs(&sub.quantized, sub.quantized[0], syms, raw);
                }
                continue;
            }

            // Полный RD: проба 16×16 против четырёх 8×8.
            let ac_bias16 = adaptive_ac_bias(block_activity16(&orig16));
            let b16 = border16(&recon, w, h, sbx, sby);
            let (mode16, pred16, quant16, cost16) =
                choose_mode16(&orig16, &b16, None, &qmat16, lambda, N_MODES_V3, ac_bias16);
            let cost_whole = cost16 + lambda * MODE_COST_BITS as f32;

            // Ранний выход: стоимости подблоков неотрицательны, поэтому как
            // только частичная сумма превысила cost_whole — победитель ясен,
            // оставшиеся 8×8 не считаются (частый случай на гладких зонах,
            // не пойманных hint'ом).
            let backup = save_region16(&recon, w, h, sbx, sby);
            let mut cost_split = 0f32;
            subs.clear();
            for (bx, by) in sub_blocks(sbx, sby, w, h) {
                let (sub, cost) = eval_block8(buf, &mut recon, w, h, bx, by, qmat, lambda);
                cost_split += cost;
                subs.push(sub);
                if cost_split > cost_whole {
                    break;
                }
            }

            if cost_whole <= cost_split {
                restore_region16(&mut recon, w, h, sbx, sby, &backup);
                syms.push((CTX_SPLIT, SPLIT_WHOLE));
                syms.push((CTX_MODE, mode16));
                encode_coeffs16(&quant16, syms, raw);
                let mut freq = [0f32; 256];
                let mut spatial = [0f32; 256];
                for i in 0..256 {
                    freq[i] = quant16[i] as f32 * f32::from(qmat16[i]);
                }
                idct16(&freq, &mut spatial);
                store_block16(&mut recon, w, h, sbx, sby, &spatial, &pred16);
            } else {
                syms.push((CTX_SPLIT, SPLIT_QUAD));
                for sub in &subs {
                    syms.push((CTX_MODE, sub.mode));
                    encode_coeffs(&sub.quantized, sub.quantized[0], syms, raw);
                }
            }
        }
    }
}

/// Снимок области суперблока в реконструкции (клипованный).
fn save_region16(recon: &[i16], w: usize, h: usize, sbx: usize, sby: usize) -> [i16; 256] {
    let mut out = [0i16; 256];
    for y in 0..16 {
        let sy = sby * 16 + y;
        if sy >= h {
            break;
        }
        for x in 0..16 {
            let sx = sbx * 16 + x;
            if sx >= w {
                break;
            }
            out[y * 16 + x] = recon[sy * w + sx];
        }
    }
    out
}

/// Откат области суперблока.
fn restore_region16(
    recon: &mut [i16],
    w: usize,
    h: usize,
    sbx: usize,
    sby: usize,
    saved: &[i16; 256],
) {
    for y in 0..16 {
        let sy = sby * 16 + y;
        if sy >= h {
            break;
        }
        for x in 0..16 {
            let sx = sbx * 16 + x;
            if sx >= w {
                break;
            }
            recon[sy * w + sx] = saved[y * 16 + x];
        }
    }
}

/// Декодирует тайл-плоскость битстрима v5.
pub fn decode_tile_plane_v5(
    section: &Section<'_>,
    dec: &mut RansDecoder<'_>,
    raw: &mut BitReader<'_>,
    w: usize,
    h: usize,
    qmat: &[u16; 64],
) -> Result<Vec<i16>, DecodeError> {
    let sb_cols = w.div_ceil(16);
    let sb_rows = h.div_ceil(16);
    let qmat16 = quant_matrix16(qmat);
    let mut recon = vec![0i16; w * h];
    let mut freq16 = [0f32; 256];
    let mut spatial16 = [0f32; 256];
    let mut freq = [0f32; 64];
    let mut spatial = [0f32; 64];
    for sby in 0..sb_rows {
        for sbx in 0..sb_cols {
            let split = dec.get(&section.tables[usize::from(CTX_SPLIT)])?;
            match split {
                SPLIT_WHOLE => {
                    let mode = dec.get(&section.tables[usize::from(CTX_MODE)])?;
                    if mode >= N_MODES_V3 {
                        return Err(DecodeError::Corrupt("dct16: неизвестная мода предикции"));
                    }
                    let b = border16(&recon, w, h, sbx, sby);
                    let pred = predict_block16(&b, mode);
                    let dc_token = decode_coeffs16(section, dec, raw, &qmat16, &mut freq16)?;
                    freq16[0] = dc_token as f32 * f32::from(qmat16[0]);
                    idct16(&freq16, &mut spatial16);
                    store_block16(&mut recon, w, h, sbx, sby, &spatial16, &pred);
                }
                SPLIT_QUAD => {
                    for (bx, by) in sub_blocks(sbx, sby, w, h) {
                        let mode_sym = dec.get(&section.tables[usize::from(CTX_MODE)])?;
                        if mode_sym >= N_MODES_V3 {
                            return Err(DecodeError::Corrupt("dct: неизвестная мода предикции"));
                        }
                        let b = border(&recon, w, h, bx, by);
                        let pred = predict_block(&b, mode_sym);
                        let dc_token = decode_coeffs(section, dec, raw, qmat, &mut freq)?;
                        freq[0] = dc_token as f32 * f32::from(qmat[0]);
                        idct8x8(&freq, &mut spatial);
                        store_block(&mut recon, w, h, bx, by, &spatial, &pred);
                    }
                }
                _ => return Err(DecodeError::Corrupt("dct16: неизвестное split-решение")),
            }
        }
    }
    Ok(recon)
}

// --- v7: адаптивная энтропия и общие примитивы дерева ---------------------------
//
// Энтропийные примитивы общие для листьев 4/8/16/32. Символы кодируются
// range-кодером с адаптивными моделями (без таблиц в потоке), поэтому
// контекстная сетка богаче v5:
//
// - run/level: бакет позиции в зигзаге (6 градаций вместо low/high)
//   × nnz-бакет предыдущего блока плоскости (4 градации) — возврат
//   nnz-контекстов, отклонённых в v3 из-за цены таблиц;
// - поверх всего — order-1 бакеты `ModelBank` (предыдущий символ
//   того же контекста).

/// Раскладка контекстов v7 (не сериализуется, фиксирована форматом).
const CTX7_SPLIT: u8 = 0;
const CTX7_MODE: u8 = 1;
/// База DC-контекстов: 4 бакета по магнитуде DC предыдущего блока.
const CTX7_DC_BASE: u8 = 2;
/// База run-контекстов: 24 штуки (6 бакетов позиции × 4 nnz-бакета).
const CTX7_RUN_BASE: u8 = 6;
/// База level-контекстов: 24 (6 бакетов позиции × 4 бакета пред. уровня).
const CTX7_LEVEL_BASE: u8 = 30;
/// База бинарных EOB-контекстов: 24 (6 позиций × 4 nnz-бакета).
const CTX7_EOB_BASE: u8 = 54;
/// Split корневого узла 32×32: 0 — whole32, 1 — четыре узла 16×16.
const CTX7_SPLIT32: u8 = 78;
/// Split узла 8×8: 0 — whole8, 1 — четыре листа 4×4.
const CTX7_SPLIT8: u8 = 79;
/// Transform каждого whole/листа v7.4.
const CTX7_TX: u8 = 80;
/// Tile-plane CDEF strength v7.5.
pub const CTX7_CDEF: u8 = 81;
/// Общее число контекстов v7.
pub const N_CTX_V7: usize = 82;
const N_POS_BUCKETS: u8 = 6;

/// Родительские группы и виды моделей контекстов v7 для иерархического
/// прогрева (`ModelBank`): детальные run/level-контексты наследуют
/// статистику родителя своей позиционной зоны; DC-бакеты — общего
/// DC-родителя. `ModelKind` задаёт алфавит и prior.
pub fn ctx_meta_v7() -> (Vec<u8>, Vec<crate::arith::ModelKind>) {
    use crate::arith::ModelKind;
    let mut groups = vec![0u8; N_CTX_V7];
    let mut kinds = vec![ModelKind::Level; N_CTX_V7];
    groups[usize::from(CTX7_SPLIT)] = 0;
    kinds[usize::from(CTX7_SPLIT)] = ModelKind::Split;
    groups[usize::from(CTX7_MODE)] = 1;
    kinds[usize::from(CTX7_MODE)] = ModelKind::Mode;
    groups[usize::from(CTX7_SPLIT32)] = 0;
    kinds[usize::from(CTX7_SPLIT32)] = ModelKind::Split;
    groups[usize::from(CTX7_SPLIT8)] = 0;
    kinds[usize::from(CTX7_SPLIT8)] = ModelKind::Split;
    groups[usize::from(CTX7_TX)] = 21;
    kinds[usize::from(CTX7_TX)] = ModelKind::Tx;
    groups[usize::from(CTX7_CDEF)] = 22;
    kinds[usize::from(CTX7_CDEF)] = ModelKind::Cdef;
    for dc_b in 0..4u8 {
        groups[usize::from(CTX7_DC_BASE + dc_b)] = 2;
        kinds[usize::from(CTX7_DC_BASE + dc_b)] = ModelKind::Dc;
    }
    for cond in 0..4u8 {
        for pos_b in 0..N_POS_BUCKETS {
            let run = usize::from(run_ctx_v7(pos_b, cond));
            let level = usize::from(level_ctx_v7(pos_b, cond));
            let eob = usize::from(eob_ctx_v7(pos_b, cond));
            groups[run] = 3 + pos_b;
            kinds[run] = ModelKind::Run;
            groups[level] = 3 + N_POS_BUCKETS + pos_b;
            kinds[level] = ModelKind::Level;
            groups[eob] = 3 + 2 * N_POS_BUCKETS + pos_b;
            kinds[eob] = ModelKind::Eob;
        }
    }
    (groups, kinds)
}

/// Контекст DC по магнитуде DC-токена предыдущего блока.
/// A/B-замер: условность по prev_dc ухудшает (−2.43% против −2.93% без
/// неё) — DC-статистика тайла однородна, разбавление не окупается.
#[inline]
fn dc_ctx_v7(prev_dc_mag: u32) -> u8 {
    let _ = prev_dc_mag;
    CTX7_DC_BASE
}

/// Межблочное состояние контекстов v7 одной плоскости.
#[derive(Default)]
struct CtxV7 {
    /// nnz-бакет предыдущего блока (нормированный для 16×16).
    prev_nnz: u8,
    /// Магнитуда DC-токена предыдущего блока.
    prev_dc: u32,
}

/// Бакет позиции зигзага 8×8: 1 / 2–3 / 4–7 / 8–15 / 16–31 / 32+.
#[inline]
fn pos_bucket8(pos: usize) -> u8 {
    match pos {
        1 => 0,
        2..=3 => 1,
        4..=7 => 2,
        8..=15 => 3,
        16..=31 => 4,
        _ => 5,
    }
}

/// Бакет позиции зигзага 16×16: та же спектральная доля, что и 8×8.
#[inline]
fn pos_bucket16(pos: usize) -> u8 {
    pos_bucket8((pos >> 2).max(1))
}

/// Бакет заполненности предыдущего блока: 0 / 1–3 / 4–9 / 10+ ненулевых AC.
#[inline]
fn nnz_bucket(nnz: u32) -> u8 {
    match nnz {
        0 => 0,
        1..=3 => 1,
        4..=9 => 2,
        _ => 3,
    }
}

#[inline]
fn run_ctx_v7(pos_bucket: u8, nnz_b: u8) -> u8 {
    CTX7_RUN_BASE + pos_bucket + N_POS_BUCKETS * nnz_b
}

/// Бакет магнитуды предыдущего ненулевого уровня блока:
/// 0 — уровней ещё не было, 1 — |lvl|=1, 2 — 2..3, 3 — 4+.
#[inline]
fn lvl_bucket(prev_mag: u32) -> u8 {
    match prev_mag {
        0 => 0,
        1 => 1,
        2..=3 => 2,
        _ => 3,
    }
}

#[inline]
fn level_ctx_v7(pos_bucket: u8, lvl_b: u8) -> u8 {
    CTX7_LEVEL_BASE + pos_bucket + N_POS_BUCKETS * lvl_b
}

#[inline]
fn eob_ctx_v7(pos_bucket: u8, nnz_b: u8) -> u8 {
    CTX7_EOB_BASE + pos_bucket + N_POS_BUCKETS * nnz_b
}

/// Кодирует блок 8×8 в символы v7. `st` — межблочное состояние контекстов
/// плоскости (обновляется на текущий блок).
fn encode_coeffs_v7(
    quantized: &[i32; 64],
    dc_token: i32,
    tx: u8,
    st: &mut CtxV7,
    syms: &mut Vec<(u8, u8)>,
    raw: &mut BitWriter,
) {
    let scan = tx_scan8(tx);
    let nnz_b = st.prev_nnz;
    let (sym, bits, n_bits) = tokenize(zigzag(dc_token));
    syms.push((dc_ctx_v7(st.prev_dc), sym));
    write_raw(raw, bits, n_bits);
    st.prev_dc = dc_token.unsigned_abs();

    let mut nnz = 0u32;
    let mut prev_mag = 0u32;
    let mut pos = 1usize;
    while pos < 64 {
        let run_start = pos;
        let mut run = 0usize;
        while pos < 64 && quantized[scan[pos]] == 0 {
            run += 1;
            pos += 1;
        }
        let pos_b = pos_bucket8(run_start);
        if pos == 64 {
            syms.push((eob_ctx_v7(pos_b, nnz_b), 1));
            break;
        }
        syms.push((eob_ctx_v7(pos_b, nnz_b), 0));
        let (rsym, rbits, rn) = tokenize(run as u32);
        syms.push((run_ctx_v7(pos_b, nnz_b), rsym));
        write_raw(raw, rbits, rn);

        let level = quantized[scan[pos]];
        let mag = level.unsigned_abs();
        let (lsym, lbits, ln) = tokenize(mag - 1);
        syms.push((level_ctx_v7(pos_bucket8(pos), lvl_bucket(prev_mag)), lsym));
        write_raw(raw, lbits, ln);
        raw.write(u32::from(level < 0), 1);
        prev_mag = mag;
        nnz += 1;
        pos += 1;
    }
    st.prev_nnz = nnz_bucket(nnz);
}

/// Кодирует суперблок 16×16 в символы v7 (nnz нормируется на /4 —
/// сопоставимая с 8×8 плотность заполнения).
fn encode_coeffs16_v7(
    quantized: &[i32; 256],
    tx: u8,
    st: &mut CtxV7,
    syms: &mut Vec<(u8, u8)>,
    raw: &mut BitWriter,
) {
    let scan = tx_scan16(tx);
    let nnz_b = st.prev_nnz;
    let (sym, bits, n_bits) = tokenize(zigzag(quantized[0]));
    syms.push((dc_ctx_v7(st.prev_dc), sym));
    write_raw(raw, bits, n_bits);
    st.prev_dc = quantized[0].unsigned_abs();

    let mut nnz = 0u32;
    let mut prev_mag = 0u32;
    let mut pos = 1usize;
    while pos < 256 {
        let run_start = pos;
        let mut run = 0usize;
        while pos < 256 && quantized[scan[pos]] == 0 {
            run += 1;
            pos += 1;
        }
        let pos_b = pos_bucket16(run_start);
        if pos == 256 {
            syms.push((eob_ctx_v7(pos_b, nnz_b), 1));
            break;
        }
        syms.push((eob_ctx_v7(pos_b, nnz_b), 0));
        let (rsym, rbits, rn) = tokenize(run as u32);
        syms.push((run_ctx_v7(pos_b, nnz_b), rsym));
        write_raw(raw, rbits, rn);

        let level = quantized[scan[pos]];
        let mag = level.unsigned_abs();
        let (lsym, lbits, ln) = tokenize(mag - 1);
        syms.push((level_ctx_v7(pos_bucket16(pos), lvl_bucket(prev_mag)), lsym));
        write_raw(raw, lbits, ln);
        raw.write(u32::from(level < 0), 1);
        prev_mag = mag;
        nnz += 1;
        pos += 1;
    }
    st.prev_nnz = nnz_bucket(nnz / 4);
}

/// Кодирует дерево тайл-плоскости замороженного битстрима v7.
pub fn encode_tile_plane_v7(
    buf: &[i16],
    cfl_luma: Option<&[i16]>,
    w: usize,
    h: usize,
    qmat: &[u16; 64],
    syms: &mut Vec<(u8, u8)>,
    raw: &mut BitWriter,
) -> Vec<i16> {
    v72::encode_tile_plane(buf, cfl_luma, w, h, qmat, syms, raw)
}

/// Сохранённая реализация v7.1 для локального A/B во время разработки v7.2.
#[allow(dead_code)]
fn encode_tile_plane_v71(
    buf: &[i16],
    w: usize,
    h: usize,
    qmat: &[u16; 64],
    syms: &mut Vec<(u8, u8)>,
    raw: &mut BitWriter,
) {
    debug_assert_eq!(buf.len(), w * h);
    let sb_cols = w.div_ceil(16);
    let sb_rows = h.div_ceil(16);
    let qmat16 = quant_matrix16(qmat);
    let lambda = plane_lambda(qmat);
    let mut recon = vec![0i16; w * h];
    let mut subs: Vec<SubBlock> = Vec::with_capacity(4);
    let mut st = CtxV7::default();
    let emit_whole = |quant16: &[i32; 256],
                      mode16: u8,
                      st: &mut CtxV7,
                      syms: &mut Vec<(u8, u8)>,
                      raw: &mut BitWriter,
                      recon: &mut Vec<i16>,
                      pred16: &[i32; 256],
                      sbx: usize,
                      sby: usize| {
        syms.push((CTX7_SPLIT, SPLIT_WHOLE));
        syms.push((CTX7_MODE, mode16));
        encode_coeffs16_v7(quant16, TX_DCT_DCT, st, syms, raw);
        let mut freq = [0f32; 256];
        let mut spatial = [0f32; 256];
        for i in 0..256 {
            freq[i] = quant16[i] as f32 * f32::from(qmat16[i]);
        }
        idct16(&freq, &mut spatial);
        store_block16(recon, w, h, sbx, sby, &spatial, pred16);
    };
    for sby in 0..sb_rows {
        for sbx in 0..sb_cols {
            let orig16 = gather_block16_i32(buf, w, h, sbx, sby);
            let hint = split_hint(&orig16);

            if hint == Some(SPLIT_WHOLE) {
                let ac_bias16 = adaptive_ac_bias(block_activity16(&orig16));
                let b16 = border16(&recon, w, h, sbx, sby);
                let (mode16, pred16, quant16, _) =
                    choose_mode16(&orig16, &b16, None, &qmat16, lambda, N_MODES_V3, ac_bias16);
                emit_whole(
                    &quant16, mode16, &mut st, syms, raw, &mut recon, &pred16, sbx, sby,
                );
                continue;
            }
            if hint == Some(SPLIT_QUAD) {
                syms.push((CTX7_SPLIT, SPLIT_QUAD));
                for (bx, by) in sub_blocks(sbx, sby, w, h) {
                    let (sub, _) = eval_block8(buf, &mut recon, w, h, bx, by, qmat, lambda);
                    syms.push((CTX7_MODE, sub.mode));
                    encode_coeffs_v7(
                        &sub.quantized,
                        sub.quantized[0],
                        TX_DCT_DCT,
                        &mut st,
                        syms,
                        raw,
                    );
                }
                continue;
            }

            let ac_bias16 = adaptive_ac_bias(block_activity16(&orig16));
            let b16 = border16(&recon, w, h, sbx, sby);
            let (mode16, pred16, quant16, cost16) =
                choose_mode16(&orig16, &b16, None, &qmat16, lambda, N_MODES_V3, ac_bias16);
            let cost_whole = cost16 + lambda * MODE_COST_BITS as f32;

            let backup = save_region16(&recon, w, h, sbx, sby);
            let mut cost_split = 0f32;
            subs.clear();
            for (bx, by) in sub_blocks(sbx, sby, w, h) {
                let (sub, cost) = eval_block8(buf, &mut recon, w, h, bx, by, qmat, lambda);
                cost_split += cost;
                subs.push(sub);
                if cost_split > cost_whole {
                    break;
                }
            }

            if cost_whole <= cost_split {
                restore_region16(&mut recon, w, h, sbx, sby, &backup);
                emit_whole(
                    &quant16, mode16, &mut st, syms, raw, &mut recon, &pred16, sbx, sby,
                );
            } else {
                syms.push((CTX7_SPLIT, SPLIT_QUAD));
                for sub in &subs {
                    syms.push((CTX7_MODE, sub.mode));
                    encode_coeffs_v7(
                        &sub.quantized,
                        sub.quantized[0],
                        TX_DCT_DCT,
                        &mut st,
                        syms,
                        raw,
                    );
                }
            }
        }
    }
}

/// Декодирует DC + run/level блока 8×8 из адаптивного потока v7.
fn decode_coeffs_v7(
    bank: &mut ModelBank,
    dec: &mut RangeDecoder<'_>,
    raw: &mut BitReader<'_>,
    qmat: &[u16; 64],
    scan: &[usize; 64],
    freq: &mut [f32; 64],
    st: &mut CtxV7,
) -> Result<i32, DecodeError> {
    freq.fill(0.0);
    let nnz_b = st.prev_nnz;
    let dc_sym = bank.decode(dec, dc_ctx_v7(st.prev_dc))?;
    let dc_token = unzigzag(detokenize(dc_sym, raw)?);
    st.prev_dc = dc_token.unsigned_abs();

    let mut nnz = 0u32;
    let mut prev_mag = 0u32;
    let mut pos = 1usize;
    while pos < 64 {
        let pos_b = pos_bucket8(pos);
        if bank.decode(dec, eob_ctx_v7(pos_b, nnz_b))? == 1 {
            break;
        }
        let rsym = bank.decode(dec, run_ctx_v7(pos_b, nnz_b))?;
        let run = detokenize(rsym, raw)? as usize;
        let new_pos = pos
            .checked_add(run)
            .ok_or(DecodeError::Corrupt("dct: run overflow"))?;
        if new_pos >= 64 {
            return Err(DecodeError::Corrupt("dct: позиция AC вне блока"));
        }
        pos = new_pos;
        let lsym = bank.decode(dec, level_ctx_v7(pos_bucket8(pos), lvl_bucket(prev_mag)))?;
        let mag = detokenize(lsym, raw)?.wrapping_add(1);
        let sign = raw.read(1)?;
        let level = if sign == 1 { -(mag as i32) } else { mag as i32 };
        let index = scan[pos];
        freq[index] = level as f32 * f32::from(qmat[index]);
        prev_mag = mag;
        nnz += 1;
        pos += 1;
    }
    st.prev_nnz = nnz_bucket(nnz);
    Ok(dc_token)
}

/// Декодирует коэффициенты 16×16 из адаптивного потока v7.
fn decode_coeffs16_v7(
    bank: &mut ModelBank,
    dec: &mut RangeDecoder<'_>,
    raw: &mut BitReader<'_>,
    qmat16: &[u16; 256],
    scan: &[usize; 256],
    freq: &mut [f32; 256],
    st: &mut CtxV7,
) -> Result<i32, DecodeError> {
    freq.fill(0.0);
    let nnz_b = st.prev_nnz;
    let dc_sym = bank.decode(dec, dc_ctx_v7(st.prev_dc))?;
    let dc_token = unzigzag(detokenize(dc_sym, raw)?);
    st.prev_dc = dc_token.unsigned_abs();

    let mut nnz = 0u32;
    let mut prev_mag = 0u32;
    let mut pos = 1usize;
    while pos < 256 {
        let pos_b = pos_bucket16(pos);
        if bank.decode(dec, eob_ctx_v7(pos_b, nnz_b))? == 1 {
            break;
        }
        let rsym = bank.decode(dec, run_ctx_v7(pos_b, nnz_b))?;
        let run = detokenize(rsym, raw)? as usize;
        let new_pos = pos
            .checked_add(run)
            .ok_or(DecodeError::Corrupt("dct16: run overflow"))?;
        if new_pos >= 256 {
            return Err(DecodeError::Corrupt("dct16: позиция AC вне блока"));
        }
        pos = new_pos;
        let lsym = bank.decode(dec, level_ctx_v7(pos_bucket16(pos), lvl_bucket(prev_mag)))?;
        let mag = detokenize(lsym, raw)?.wrapping_add(1);
        let sign = raw.read(1)?;
        let level = if sign == 1 { -(mag as i32) } else { mag as i32 };
        let index = scan[pos];
        freq[index] = level as f32 * f32::from(qmat16[index]);
        prev_mag = mag;
        nnz += 1;
        pos += 1;
    }
    st.prev_nnz = nnz_bucket(nnz / 4);
    Ok(dc_token)
}

/// Декодирует дерево тайл-плоскости замороженного битстрима v7.
pub fn decode_tile_plane_v7(
    bank: &mut ModelBank,
    dec: &mut RangeDecoder<'_>,
    raw: &mut BitReader<'_>,
    w: usize,
    h: usize,
    cfl_luma: Option<&[i16]>,
    qmat: &[u16; 64],
) -> Result<Vec<i16>, DecodeError> {
    v72::decode_tile_plane(bank, dec, raw, w, h, cfl_luma, qmat)
}

/// Сохранённый декодер v7.1 для локального A/B.
#[allow(dead_code)]
fn decode_tile_plane_v71(
    bank: &mut ModelBank,
    dec: &mut RangeDecoder<'_>,
    raw: &mut BitReader<'_>,
    w: usize,
    h: usize,
    qmat: &[u16; 64],
) -> Result<Vec<i16>, DecodeError> {
    let sb_cols = w.div_ceil(16);
    let sb_rows = h.div_ceil(16);
    let qmat16 = quant_matrix16(qmat);
    let mut recon = vec![0i16; w * h];
    let mut freq16 = [0f32; 256];
    let mut spatial16 = [0f32; 256];
    let mut freq = [0f32; 64];
    let mut spatial = [0f32; 64];
    let mut st = CtxV7::default();
    for sby in 0..sb_rows {
        for sbx in 0..sb_cols {
            let split = bank.decode(dec, CTX7_SPLIT)?;
            match split {
                SPLIT_WHOLE => {
                    let mode = bank.decode(dec, CTX7_MODE)?;
                    if mode >= N_MODES_V3 {
                        return Err(DecodeError::Corrupt("dct16: неизвестная мода предикции"));
                    }
                    let b = border16(&recon, w, h, sbx, sby);
                    let pred = predict_block16(&b, mode);
                    let dc_token = decode_coeffs16_v7(
                        bank,
                        dec,
                        raw,
                        &qmat16,
                        &ZIGZAG16,
                        &mut freq16,
                        &mut st,
                    )?;
                    freq16[0] = dc_token as f32 * f32::from(qmat16[0]);
                    idct16(&freq16, &mut spatial16);
                    store_block16(&mut recon, w, h, sbx, sby, &spatial16, &pred);
                }
                SPLIT_QUAD => {
                    for (bx, by) in sub_blocks(sbx, sby, w, h) {
                        let mode_sym = bank.decode(dec, CTX7_MODE)?;
                        if mode_sym >= N_MODES_V3 {
                            return Err(DecodeError::Corrupt("dct: неизвестная мода предикции"));
                        }
                        let b = border(&recon, w, h, bx, by);
                        let pred = predict_block(&b, mode_sym);
                        let dc_token =
                            decode_coeffs_v7(bank, dec, raw, qmat, &ZIGZAG, &mut freq, &mut st)?;
                        freq[0] = dc_token as f32 * f32::from(qmat[0]);
                        idct8x8(&freq, &mut spatial);
                        store_block(&mut recon, w, h, bx, by, &spatial, &pred);
                    }
                }
                _ => return Err(DecodeError::Corrupt("dct16: неизвестное split-решение")),
            }
        }
    }
    Ok(recon)
}

// --- v1: DC-цепочка без предикции (декодер сохраняется навсегда) ---------------

/// Декодирует тайл-плоскость битстрима v1.
pub fn decode_tile_plane_v1(
    section: &Section<'_>,
    dec: &mut RansDecoder<'_>,
    raw: &mut BitReader<'_>,
    w: usize,
    h: usize,
    qmat: &[u16; 64],
) -> Result<Vec<i16>, DecodeError> {
    let blocks_x = w.div_ceil(8);
    let blocks_y = h.div_ceil(8);
    let mut buf = vec![0i16; w * h];
    let mut prev_dc: i32 = 0;
    let mut freq = [0f32; 64];
    let mut spatial = [0f32; 64];
    let zero_pred = [128i32; 64];
    for by in 0..blocks_y {
        for bx in 0..blocks_x {
            let dc_token = decode_coeffs(section, dec, raw, qmat, &mut freq)?;
            let dc = prev_dc.wrapping_add(dc_token);
            prev_dc = dc;
            freq[0] = dc as f32 * f32::from(qmat[0]);
            idct8x8(&freq, &mut spatial);
            store_block(&mut buf, w, h, bx, by, &spatial, &zero_pred);
        }
    }
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dct::{BASE_LUMA, quant_matrix};
    use crate::section::{read_dct_section, write_dct_section};

    fn psnr(a: &[i16], b: &[i16]) -> f64 {
        let mse: f64 = a
            .iter()
            .zip(b.iter())
            .map(|(&x, &y)| {
                let d = f64::from(x) - f64::from(y);
                d * d
            })
            .sum::<f64>()
            / a.len() as f64;
        if mse == 0.0 {
            return f64::INFINITY;
        }
        10.0 * (255.0 * 255.0 / mse).log10()
    }

    fn smooth_image(w: usize, h: usize) -> Vec<i16> {
        (0..w * h)
            .map(|i| {
                let x = (i % w) as f64;
                let y = (i / w) as f64;
                let v = 128.0
                    + 60.0 * (x / 19.0).sin()
                    + 50.0 * (y / 13.0).cos()
                    + 10.0 * ((x + y) / 7.0).sin();
                v.clamp(0.0, 255.0) as i16
            })
            .collect()
    }

    fn roundtrip_psnr(w: usize, h: usize, quality: u8) -> f64 {
        let buf = smooth_image(w, h);
        let qmat = quant_matrix(&BASE_LUMA, quality);
        let mut syms = Vec::new();
        let mut raw = BitWriter::new();
        encode_tile_plane(&buf, w, h, &qmat, &mut syms, &mut raw);
        let mut out = Vec::new();
        write_dct_section(&mut out, N_CTX_V3, &syms, raw);

        let (section, used) = read_dct_section(&out, N_CTX_V3).unwrap();
        assert_eq!(used, out.len());
        let mut dec = RansDecoder::new(section.tokens).unwrap();
        let mut raw_reader = BitReader::new(section.raw);
        let decoded = decode_tile_plane(&section, &mut dec, &mut raw_reader, w, h, &qmat).unwrap();
        dec.finish().unwrap();
        psnr(&buf, &decoded)
    }

    #[test]
    fn high_quality_reconstruction_is_accurate() {
        let p = roundtrip_psnr(64, 48, 95);
        assert!(p > 45.0, "PSNR {p:.1} dB слишком низкий для q=95");
    }

    #[test]
    fn quality_monotonic_in_fidelity() {
        let p30 = roundtrip_psnr(64, 64, 30);
        let p90 = roundtrip_psnr(64, 64, 90);
        assert!(
            p90 > p30,
            "q=90 ({p90:.1} dB) должен быть точнее q=30 ({p30:.1} dB)"
        );
    }

    #[test]
    fn non_multiple_of_8_dimensions() {
        let p = roundtrip_psnr(13, 9, 80);
        assert!(p > 30.0);
    }

    #[test]
    fn flat_gradient_prefers_directional_modes() {
        // Горизонтальный градиент: H/TM-моды должны дать компактный поток
        // и высокую точность.
        let (w, h) = (64, 64);
        let buf: Vec<i16> = (0..w * h).map(|i| ((i % w) * 4).min(255) as i16).collect();
        let qmat = quant_matrix(&BASE_LUMA, 75);
        let mut syms = Vec::new();
        let mut raw = BitWriter::new();
        encode_tile_plane(&buf, w, h, &qmat, &mut syms, &mut raw);
        let mut out = Vec::new();
        write_dct_section(&mut out, N_CTX_V3, &syms, raw);
        let (section, _) = read_dct_section(&out, N_CTX_V3).unwrap();
        let mut dec = RansDecoder::new(section.tokens).unwrap();
        let mut raw_reader = BitReader::new(section.raw);
        let decoded = decode_tile_plane(&section, &mut dec, &mut raw_reader, w, h, &qmat).unwrap();
        dec.finish().unwrap();
        assert!(psnr(&buf, &decoded) > 40.0);
        assert!(out.len() < 700, "градиент занял {} байт", out.len());
    }

    #[test]
    fn smooth_predictor_is_integer_exact_at_8_and_16() {
        let b8 = Border {
            above: [0; 16],
            left: [255; 8],
            corner: 127,
        };
        let p8 = predict_block(&b8, MODE_SMOOTH);
        assert_eq!([p8[0], p8[7], p8[56], p8[63]], [128, 16, 239, 128]);

        let b16 = Border16 {
            above: [0; 32],
            left: [255; 16],
            corner: 127,
        };
        let p16 = predict_block16(&b16, MODE_SMOOTH);
        assert_eq!([p16[0], p16[15], p16[240], p16[255]], [128, 8, 247, 128]);
    }

    #[test]
    fn smooth_mode_wins_exact_surfaces() {
        let mut b8 = Border {
            above: [0; 16],
            left: [0; 8],
            corner: 113,
        };
        for (i, v) in b8.above.iter_mut().enumerate() {
            *v = ((i * 17 + 23) & 255) as i32;
        }
        for (i, v) in b8.left.iter_mut().enumerate() {
            *v = ((i * 29 + 41) & 255) as i32;
        }
        let orig8 = predict_block(&b8, MODE_SMOOTH);
        let qmat = quant_matrix(&BASE_LUMA, 90);
        let (mode8, _, _, _) = choose_mode(
            &orig8,
            &b8,
            None,
            &qmat,
            plane_lambda(&qmat),
            N_MODES_V7_INTRA,
            AC_BIAS,
        );
        assert_eq!(mode8, MODE_SMOOTH);

        let mut b16 = Border16 {
            above: [0; 32],
            left: [0; 16],
            corner: 97,
        };
        for (i, v) in b16.above.iter_mut().enumerate() {
            *v = ((i * 13 + 19) & 255) as i32;
        }
        for (i, v) in b16.left.iter_mut().enumerate() {
            *v = ((i * 31 + 7) & 255) as i32;
        }
        let orig16 = predict_block16(&b16, MODE_SMOOTH);
        let qmat16 = quant_matrix16(&qmat);
        let (mode16, _, _, _) = choose_mode16(
            &orig16,
            &b16,
            None,
            &qmat16,
            plane_lambda(&qmat),
            N_MODES_V7_INTRA,
            AC_BIAS,
        );
        assert_eq!(mode16, MODE_SMOOTH);
    }

    #[test]
    fn trellis_prunes_weak_tail_but_keeps_strong_ac() {
        let qmat = [10u16; 64];
        let lambda = plane_lambda(&qmat);
        let mut freq = [0f32; 64];
        freq[ZIGZAG[1]] = 10.0;
        freq[ZIGZAG[2]] = 5.5;
        let mut quantized = [0i32; 64];
        quantized[ZIGZAG[1]] = 1;
        quantized[ZIGZAG[2]] = 1;

        let (optimized, _) = trellis_rdoq(
            &freq,
            &qmat,
            quantized,
            lambda,
            &ZIGZAG,
            squared_quant_error,
        );
        assert_eq!(optimized[ZIGZAG[1]], 1);
        assert_eq!(optimized[ZIGZAG[2]], 0);
    }

    #[test]
    fn adaptive_bias_monotonic_in_activity() {
        // Гладкий блок — базовый dead-zone, насыщенный — агрессивнее.
        let flat = [128i32; 64];
        assert_eq!(block_activity(&flat), 0.0);
        assert_eq!(adaptive_ac_bias(block_activity(&flat)), AQ_BIAS_FLAT);

        let mut busy = [0i32; 64];
        for (i, v) in busy.iter_mut().enumerate() {
            *v = if i % 2 == 0 { 0 } else { 255 };
        }
        assert!(block_activity(&busy) > AQ_ACT_HI);
        assert_eq!(adaptive_ac_bias(block_activity(&busy)), AQ_BIAS_BUSY);

        // Между порогами — строго между опорными значениями.
        let mid = adaptive_ac_bias((AQ_ACT_LO + AQ_ACT_HI) / 2.0);
        assert!(mid < AQ_BIAS_FLAT && mid > AQ_BIAS_BUSY);
    }

    fn roundtrip_v5(
        buf: &[i16],
        w: usize,
        h: usize,
        quality: u8,
    ) -> (Vec<i16>, Vec<u8>, Vec<(u8, u8)>) {
        let qmat = quant_matrix(&BASE_LUMA, quality);
        let mut syms = Vec::new();
        let mut raw = BitWriter::new();
        encode_tile_plane_v5(buf, w, h, &qmat, &mut syms, &mut raw);
        let mut out = Vec::new();
        write_dct_section(&mut out, N_CTX_V5, &syms, raw);
        let (section, used) = read_dct_section(&out, N_CTX_V5).unwrap();
        assert_eq!(used, out.len());
        let mut dec = RansDecoder::new(section.tokens).unwrap();
        let mut raw_reader = BitReader::new(section.raw);
        let decoded =
            decode_tile_plane_v5(&section, &mut dec, &mut raw_reader, w, h, &qmat).unwrap();
        dec.finish().unwrap();
        assert_eq!(raw_reader.unread_bytes(), 0);
        (decoded, out, syms)
    }

    #[test]
    fn v5_roundtrip_matches_encoder_recon() {
        let (w, h) = (64, 48);
        let buf = smooth_image(w, h);
        let (decoded, _, _) = roundtrip_v5(&buf, w, h, 75);
        assert!(psnr(&buf, &decoded) > 35.0);
    }

    #[test]
    fn v5_smooth_zones_choose_whole_superblocks() {
        // Плавный градиент: RD обязан выбирать 16×16 хотя бы частично,
        // и поток обязан быть не больше v3.
        let (w, h) = (128, 128);
        let buf: Vec<i16> = (0..w * h)
            .map(|i| (((i % w) + (i / w)) / 2).min(255) as i16)
            .collect();
        let qmat = quant_matrix(&BASE_LUMA, 75);

        let (_, v5_bytes, syms) = roundtrip_v5(&buf, w, h, 75);
        let whole = syms
            .iter()
            .filter(|&&(c, s)| c == CTX_SPLIT && s == SPLIT_WHOLE)
            .count();
        assert!(whole > 0, "гладкая зона не выбрала ни одного суперблока");

        let mut syms3 = Vec::new();
        let mut raw3 = BitWriter::new();
        encode_tile_plane(&buf, w, h, &qmat, &mut syms3, &mut raw3);
        let mut v3_bytes = Vec::new();
        write_dct_section(&mut v3_bytes, N_CTX_V3, &syms3, raw3);
        assert!(
            v5_bytes.len() <= v3_bytes.len(),
            "v5 ({}) не должен быть больше v3 ({}) на гладком поле",
            v5_bytes.len(),
            v3_bytes.len()
        );
    }

    #[test]
    fn v5_non_multiple_of_16_dimensions() {
        for (w, h) in [(17usize, 9usize), (16, 16), (24, 40), (7, 7), (33, 1)] {
            let buf = smooth_image(w, h);
            let (decoded, _, _) = roundtrip_v5(&buf, w, h, 80);
            assert_eq!(decoded.len(), w * h);
            assert!(psnr(&buf, &decoded) > 28.0, "{w}x{h}");
        }
    }

    #[test]
    fn split_hint_covers_three_branches() {
        // Гладкий: WHOLE без пробы.
        let flat = [140i32; 256];
        assert_eq!(split_hint(&flat), Some(SPLIT_WHOLE));

        // Равномерно насыщенный (шахматный шум): тоже WHOLE (все AC умирают,
        // один DC дешевле четырёх).
        let mut busy = [0i32; 256];
        for (i, v) in busy.iter_mut().enumerate() {
            *v = if (i + i / 16) % 2 == 0 { 0 } else { 255 };
        }
        assert_eq!(split_hint(&busy), Some(SPLIT_WHOLE));

        // Гетерогенный (один квадрант шумный, остальные гладкие): QUAD.
        let mut mixed = [128i32; 256];
        for y in 0..8 {
            for x in 0..8 {
                mixed[y * 16 + x] = if (x + y) % 2 == 0 { 0 } else { 255 };
            }
        }
        assert_eq!(split_hint(&mixed), Some(SPLIT_QUAD));
    }

    #[test]
    fn diagonal_texture_prefers_d45_or_d135() {
        // Диагональные полосы: v3-моды должны дать компактный поток.
        let (w, h) = (64, 64);
        let buf: Vec<i16> = (0..w * h)
            .map(|i| {
                let (x, y) = (i % w, i / w);
                (((x + y) % 16) * 16).min(255) as i16
            })
            .collect();
        let qmat = quant_matrix(&BASE_LUMA, 75);
        let mut syms = Vec::new();
        let mut raw = BitWriter::new();
        encode_tile_plane(&buf, w, h, &qmat, &mut syms, &mut raw);
        let d45 = syms
            .iter()
            .filter(|&&(c, s)| c == CTX_MODE && (s == MODE_D45 || s == MODE_D135))
            .count();
        assert!(d45 > 0, "диагональная текстура не выбрала D45/D135");
    }
}
