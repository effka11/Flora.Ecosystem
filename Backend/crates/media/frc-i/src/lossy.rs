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
//!
//! AC-контексты по заполненности соседних блоков (сумма nnz слева/сверху,
//! модель JXL/AV1) были реализованы и измерены при разработке v3 — на всём
//! корпусе они ухудшают плотность (+5..8%): разбиение статистики на бакеты
//! платит за дополнительные частотные таблицы тайла больше, чем выигрывает
//! от условности, а внутри тайла распределение достаточно однородно.
//! Как и в lossless (run-режим, bias-коррекция), приёмы кодеков с
//! адаптивными вероятностями не переносятся на статические таблицы rANS.

use crate::bits::{BitReader, BitWriter};
use crate::dct::{ZIGZAG, fdct8x8, idct8x8};
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

const CTX_DC: u8 = 0;
const CTX_RUN_LOW: u8 = 1;
const CTX_RUN_HIGH: u8 = 2;
const CTX_LEVEL_LOW: u8 = 3;
const CTX_LEVEL_HIGH: u8 = 4;
/// Мода intra-предикции блока (v2/v3).
const CTX_MODE: u8 = 5;

/// Символ конца блока в run-контекстах (run <= 62 занимает символы <= 17).
const EOB_SYM: u8 = 31;
/// Граница низкочастотной зоны зигзага.
const LOW_BAND_END: usize = 15;

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

/// Выбор моды: минимум полной RD-стоимости `D + λ·R`, где D — SSE ошибки
/// квантования в DCT-домене (базис ортонормирован, равно SSE в пикселях),
/// R — оценка битовой стоимости токенов. При равенстве — младшая мода.
/// Детерминировано; решение кодера, формат не ограничивает.
fn choose_mode(
    orig: &[i32; 64],
    b: &Border,
    qmat: &[u16; 64],
    lambda: f32,
) -> (u8, [i32; 64], [i32; 64]) {
    let mut best: Option<(u8, [i32; 64], [i32; 64], f32)> = None;
    for mode in [MODE_DC, MODE_V, MODE_H, MODE_TM, MODE_D45, MODE_D135] {
        let pred = predict_block(b, mode);
        let (quantized, distortion) = quantize_residual(orig, &pred, qmat);
        let cost = distortion + lambda * coeff_cost(&quantized) as f32;
        let better = match &best {
            Some((_, _, _, c)) => cost < *c,
            None => true,
        };
        if better {
            best = Some((mode, pred, quantized, cost));
        }
    }
    let (mode, pred, quantized, _) = best.expect("моды всегда есть");
    (mode, pred, quantized)
}

/// Лагранжиан плоскости из среднего шага квантования.
fn plane_lambda(qmat: &[u16; 64]) -> f32 {
    let mean: f32 = qmat.iter().map(|&q| f32::from(q)).sum::<f32>() / 64.0;
    LAMBDA_SCALE * mean * mean
}

/// DCT остатка `orig - pred` и квантование по `qmat` с dead-zone для AC.
/// Возвращает квантованный блок и SSE ошибки квантования в DCT-домене.
fn quantize_residual(orig: &[i32; 64], pred: &[i32; 64], qmat: &[u16; 64]) -> ([i32; 64], f32) {
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
        let bias = if i == 0 { 0.5 } else { AC_BIAS };
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

/// Кодирует тайл-плоскость (битстрим v3). Ведёт реконструкцию для предикции.
pub fn encode_tile_plane(
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
    let lambda = plane_lambda(qmat);
    let mut recon = vec![0i16; w * h];
    let mut freq = [0f32; 64];
    let mut spatial = [0f32; 64];
    for by in 0..blocks_y {
        for bx in 0..blocks_x {
            let orig = gather_block_i32(buf, w, h, bx, by);
            let b = border(&recon, w, h, bx, by);
            let (mode, pred, quantized) = choose_mode(&orig, &b, qmat, lambda);
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
