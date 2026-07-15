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
    ZIGZAG, ZIGZAG16, fdct8x8, fdct8x8_cols, fdct8x8_const, fdct8x8_rows, fdct16, fdct16_cols,
    fdct16_const, fdct16_rows, idct8x8, idct16, quant_matrix16,
};
use crate::error::DecodeError;
use crate::rans::RansDecoder;
use crate::section::Section;
use crate::tokens::{detokenize, tokenize, unzigzag, write_raw, zigzag};

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
const N_MODES_V2: u8 = 4;
const N_MODES_V3: u8 = 6;

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

/// Выбор моды: минимум полной RD-стоимости `D + λ·R`, где D — SSE ошибки
/// квантования в DCT-домене (базис ортонормирован, равно SSE в пикселях),
/// R — оценка битовой стоимости токенов. При равенстве — младшая мода.
/// Детерминировано; решение кодера, формат не ограничивает.
/// Возвращает и стоимость — v5 сравнивает split-варианты по ней.
fn choose_mode(
    orig: &[i32; 64],
    b: &Border,
    qmat: &[u16; 64],
    lambda: f32,
    max_mode: u8,
    ac_bias: f32,
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
    let mut sads: Vec<(u8, u64)> = Vec::with_capacity(6);
    let mut preds = [[0i32; 64]; 6];
    for mode in [MODE_DC, MODE_V, MODE_H, MODE_TM, MODE_D45, MODE_D135] {
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
        let cost = distortion + lambda * coeff_cost(&quantized) as f32;
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
fn coeff_cost(quantized: &[i32; 64]) -> u32 {
    let mut cost = 4u32; // DC-токен + EOB
    let dc = quantized[0].unsigned_abs();
    cost += 2 * (32 - dc.leading_zeros());
    for pos in 1..64 {
        let v = quantized[ZIGZAG[pos]].unsigned_abs();
        if v != 0 {
            cost += 6 + 2 * (32 - v.leading_zeros());
        }
    }
    cost
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
                choose_mode(&orig, &b, qmat, lambda, max_mode, ac_bias);
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
    let mut cost = 4u32;
    let dc = quantized[0].unsigned_abs();
    cost += 2 * (32 - dc.leading_zeros());
    for pos in 1..256 {
        let v = quantized[ZIGZAG16[pos]].unsigned_abs();
        if v != 0 {
            cost += 6 + 2 * (32 - v.leading_zeros());
        }
    }
    cost
}

/// Выбор моды суперблока (аналог `choose_mode`, 6 мод v3; та же
/// оптимизация линейностью DCT для DC/V/H).
fn choose_mode16(
    orig: &[i32; 256],
    b: &Border16,
    qmat16: &[u16; 256],
    lambda: f32,
    ac_bias: f32,
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
    let mut sads: Vec<(u8, u64)> = Vec::with_capacity(6);
    let mut preds = [[0i32; 256]; 6];
    for mode in [MODE_DC, MODE_V, MODE_H, MODE_TM, MODE_D45, MODE_D135] {
        let pred = predict_block16(b, mode);
        let sad: u64 = orig
            .iter()
            .zip(pred.iter())
            .map(|(&o, &p)| u64::from(o.abs_diff(p)))
            .sum();
        preds[usize::from(mode)] = pred;
        sads.push((mode, sad));
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
        let cost = distortion + lambda * coeff_cost16(&quantized) as f32;
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
    let (mode, pred, quantized, cost) = choose_mode(&orig, &b, qmat, lambda, N_MODES_V3, ac_bias);
    let mut freq = [0f32; 64];
    let mut spatial = [0f32; 64];
    for i in 0..64 {
        freq[i] = quantized[i] as f32 * f32::from(qmat[i]);
    }
    idct8x8(&freq, &mut spatial);
    store_block(recon, w, h, bx, by, &spatial, &pred);
    (
        SubBlock { mode, quantized },
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
                    choose_mode16(&orig16, &b16, &qmat16, lambda, ac_bias16);
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
                choose_mode16(&orig16, &b16, &qmat16, lambda, ac_bias16);
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

// --- v7: слой блоков v5 + адаптивная энтропия (FRC-I.md §11.3, v7.1) -----------
//
// Слой блоков (обход, RD, реконструкция) идентичен v5, меняется только
// энтропийное моделирование: символы кодируются range-кодером с
// адаптивными моделями (без таблиц в потоке), и раз контексты стали
// бесплатными — их сетка гораздо богаче v5:
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
/// Общее число контекстов v7.
pub const N_CTX_V7: usize = 54;
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
    for dc_b in 0..4u8 {
        groups[usize::from(CTX7_DC_BASE + dc_b)] = 2;
        kinds[usize::from(CTX7_DC_BASE + dc_b)] = ModelKind::Dc;
    }
    for cond in 0..4u8 {
        for pos_b in 0..N_POS_BUCKETS {
            let run = usize::from(run_ctx_v7(pos_b, cond));
            let level = usize::from(level_ctx_v7(pos_b, cond));
            groups[run] = 3 + pos_b;
            kinds[run] = ModelKind::Run;
            groups[level] = 3 + N_POS_BUCKETS + pos_b;
            kinds[level] = ModelKind::Level;
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

/// Кодирует блок 8×8 в символы v7. `st` — межблочное состояние контекстов
/// плоскости (обновляется на текущий блок).
fn encode_coeffs_v7(
    quantized: &[i32; 64],
    dc_token: i32,
    st: &mut CtxV7,
    syms: &mut Vec<(u8, u8)>,
    raw: &mut BitWriter,
) {
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
        while pos < 64 && quantized[ZIGZAG[pos]] == 0 {
            run += 1;
            pos += 1;
        }
        if pos == 64 {
            syms.push((run_ctx_v7(pos_bucket8(run_start), nnz_b), EOB_SYM));
            break;
        }
        let (rsym, rbits, rn) = tokenize(run as u32);
        syms.push((run_ctx_v7(pos_bucket8(run_start), nnz_b), rsym));
        write_raw(raw, rbits, rn);

        let level = quantized[ZIGZAG[pos]];
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
    st: &mut CtxV7,
    syms: &mut Vec<(u8, u8)>,
    raw: &mut BitWriter,
) {
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
        while pos < 256 && quantized[ZIGZAG16[pos]] == 0 {
            run += 1;
            pos += 1;
        }
        if pos == 256 {
            syms.push((run_ctx_v7(pos_bucket16(run_start), nnz_b), EOB_SYM));
            break;
        }
        let (rsym, rbits, rn) = tokenize(run as u32);
        syms.push((run_ctx_v7(pos_bucket16(run_start), nnz_b), rsym));
        write_raw(raw, rbits, rn);

        let level = quantized[ZIGZAG16[pos]];
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

/// Кодирует тайл-плоскость битстрима v7: слой блоков v5, контексты v7.
pub fn encode_tile_plane_v7(
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
        encode_coeffs16_v7(quant16, st, syms, raw);
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
                    choose_mode16(&orig16, &b16, &qmat16, lambda, ac_bias16);
                emit_whole(
                    &quant16,
                    mode16,
                    &mut st,
                    syms,
                    raw,
                    &mut recon,
                    &pred16,
                    sbx,
                    sby,
                );
                continue;
            }
            if hint == Some(SPLIT_QUAD) {
                syms.push((CTX7_SPLIT, SPLIT_QUAD));
                for (bx, by) in sub_blocks(sbx, sby, w, h) {
                    let (sub, _) = eval_block8(buf, &mut recon, w, h, bx, by, qmat, lambda);
                    syms.push((CTX7_MODE, sub.mode));
                    encode_coeffs_v7(&sub.quantized, sub.quantized[0], &mut st, syms, raw);
                }
                continue;
            }

            let ac_bias16 = adaptive_ac_bias(block_activity16(&orig16));
            let b16 = border16(&recon, w, h, sbx, sby);
            let (mode16, pred16, quant16, cost16) =
                choose_mode16(&orig16, &b16, &qmat16, lambda, ac_bias16);
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
                    &quant16,
                    mode16,
                    &mut st,
                    syms,
                    raw,
                    &mut recon,
                    &pred16,
                    sbx,
                    sby,
                );
            } else {
                syms.push((CTX7_SPLIT, SPLIT_QUAD));
                for sub in &subs {
                    syms.push((CTX7_MODE, sub.mode));
                    encode_coeffs_v7(&sub.quantized, sub.quantized[0], &mut st, syms, raw);
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
        let rsym = bank.decode(dec, run_ctx_v7(pos_bucket8(pos), nnz_b))?;
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
        let lsym = bank.decode(dec, level_ctx_v7(pos_bucket8(pos), lvl_bucket(prev_mag)))?;
        let mag = detokenize(lsym, raw)?.wrapping_add(1);
        let sign = raw.read(1)?;
        let level = if sign == 1 { -(mag as i32) } else { mag as i32 };
        freq[ZIGZAG[pos]] = level as f32 * f32::from(qmat[ZIGZAG[pos]]);
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
        let rsym = bank.decode(dec, run_ctx_v7(pos_bucket16(pos), nnz_b))?;
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
        let lsym = bank.decode(dec, level_ctx_v7(pos_bucket16(pos), lvl_bucket(prev_mag)))?;
        let mag = detokenize(lsym, raw)?.wrapping_add(1);
        let sign = raw.read(1)?;
        let level = if sign == 1 { -(mag as i32) } else { mag as i32 };
        freq[ZIGZAG16[pos]] = level as f32 * f32::from(qmat16[ZIGZAG16[pos]]);
        prev_mag = mag;
        nnz += 1;
        pos += 1;
    }
    st.prev_nnz = nnz_bucket(nnz / 4);
    Ok(dc_token)
}

/// Декодирует тайл-плоскость битстрима v7 (слой v5, адаптивная энтропия).
pub fn decode_tile_plane_v7(
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
                    let dc_token =
                        decode_coeffs16_v7(bank, dec, raw, &qmat16, &mut freq16, &mut st)?;
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
                        let dc_token = decode_coeffs_v7(bank, dec, raw, qmat, &mut freq, &mut st)?;
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
