//! Lossy-кодер плоскости (FIC.md §7): DCT 8x8, перцептивное квантование,
//! run/level кодирование AC-коэффициентов.
//!
//! v2 добавляет направленную intra-предикцию блоков от реконструированных
//! соседей (моды DC/V/H/TM, как в VP8): DCT кодирует остаток предсказания,
//! мода сигналится отдельным контекстом. DC-цепочка v1 при этом не нужна —
//! предсказание уже поглощает межблочную корреляцию, и DC остатка кодируется
//! напрямую. Декодер v1 (без предикции, с DC-цепочкой) сохранён навсегда.

use crate::bits::{BitReader, BitWriter};
use crate::dct::{ZIGZAG, fdct8x8, idct8x8};
use crate::error::DecodeError;
use crate::rans::RansDecoder;
use crate::section::Section;
use crate::tokens::{detokenize, tokenize, unzigzag, write_raw, zigzag};

/// Контексты v1: DC, run (низкие/высокие частоты), level (низкие/высокие).
pub const N_CTX_V1: usize = 5;
/// Контексты v2: + мода intra-предикции.
pub const N_CTX_V2: usize = 6;

const CTX_DC: u8 = 0;
const CTX_RUN_LOW: u8 = 1;
const CTX_RUN_HIGH: u8 = 2;
const CTX_LEVEL_LOW: u8 = 3;
const CTX_LEVEL_HIGH: u8 = 4;
/// Мода intra-предикции блока (только v2).
const CTX_MODE: u8 = 5;

/// Символ конца блока в run-контекстах (run <= 62 занимает символы <= 17).
const EOB_SYM: u8 = 31;
/// Граница низкочастотной зоны зигзага.
const LOW_BAND_END: usize = 15;

/// Моды intra-предикции v2 (значения фиксированы форматом).
const MODE_DC: u8 = 0;
const MODE_V: u8 = 1;
const MODE_H: u8 = 2;
const MODE_TM: u8 = 3;
const N_MODES: u8 = 4;

#[inline]
fn run_ctx(pos: usize) -> u8 {
    if pos <= LOW_BAND_END { CTX_RUN_LOW } else { CTX_RUN_HIGH }
}

#[inline]
fn level_ctx(pos: usize) -> u8 {
    if pos <= LOW_BAND_END { CTX_LEVEL_LOW } else { CTX_LEVEL_HIGH }
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

// --- intra-предикция (v2) ----------------------------------------------------

/// Граница блока из реконструкции: верхняя строка, левый столбец, угол.
/// Недоступные соседи замещаются 128 (координаты клампятся в валидную зону).
struct Border {
    above: [i32; 8],
    left: [i32; 8],
    corner: i32,
}

fn border(recon: &[i16], w: usize, h: usize, bx: usize, by: usize) -> Border {
    let (px, py) = (bx * 8, by * 8);
    let mut above = [128i32; 8];
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
    Border { above, left, corner }
}

/// Предсказание блока модой `mode` от границы.
fn predict_block(b: &Border, mode: u8) -> [i32; 64] {
    let mut out = [0i32; 64];
    match mode {
        MODE_V => {
            for y in 0..8 {
                out[y * 8..y * 8 + 8].copy_from_slice(&b.above);
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
        _ => {
            // DC: среднее 16 граничных отсчётов (замещённые участвуют).
            let sum: i32 = b.above.iter().sum::<i32>() + b.left.iter().sum::<i32>();
            let dc = (sum + 8) >> 4;
            out.fill(dc);
        }
    }
    out
}

/// Выбор моды: минимальная сумма модулей остатка (SAD), при равенстве —
/// младшая мода. Детерминировано; решение кодера, формат не ограничивает.
fn choose_mode(orig: &[i32; 64], b: &Border) -> (u8, [i32; 64]) {
    let mut best_mode = MODE_DC;
    let mut best_pred = predict_block(b, MODE_DC);
    let mut best_sad = sad(orig, &best_pred);
    for mode in [MODE_V, MODE_H, MODE_TM] {
        let pred = predict_block(b, mode);
        let s = sad(orig, &pred);
        if s < best_sad {
            best_sad = s;
            best_mode = mode;
            best_pred = pred;
        }
    }
    (best_mode, best_pred)
}

#[inline]
fn sad(a: &[i32; 64], b: &[i32; 64]) -> i64 {
    a.iter().zip(b.iter()).map(|(&x, &y)| i64::from((x - y).abs())).sum()
}

// --- общее кодирование коэффициентов ------------------------------------------

/// Кодирует квантованный блок (DC-токен + run/level AC) в потоки.
fn encode_coeffs(quantized: &[i32; 64], dc_token: i32, syms: &mut Vec<(u8, u8)>, raw: &mut BitWriter) {
    let (sym, bits, n_bits) = tokenize(zigzag(dc_token));
    syms.push((CTX_DC, sym));
    write_raw(raw, bits, n_bits);

    let mut pos = 1usize;
    while pos < 64 {
        let mut run = 0usize;
        while pos < 64 && quantized[ZIGZAG[pos]] == 0 {
            run += 1;
            pos += 1;
        }
        if pos == 64 {
            syms.push((run_ctx(64 - run), EOB_SYM));
            break;
        }
        let (rsym, rbits, rn) = tokenize(run as u32);
        syms.push((run_ctx(pos - run), rsym));
        write_raw(raw, rbits, rn);

        let level = quantized[ZIGZAG[pos]];
        let (lsym, lbits, ln) = tokenize(level.unsigned_abs() - 1);
        syms.push((level_ctx(pos), lsym));
        write_raw(raw, lbits, ln);
        raw.write(u32::from(level < 0), 1);
        pos += 1;
    }
}

/// Декодирует квантованный блок; возвращает деквантованные частоты.
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
        let new_pos = pos.checked_add(run).ok_or(DecodeError::Corrupt("dct: run overflow"))?;
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

// --- v2: intra-предикция + DCT остатка ----------------------------------------

/// Кодирует тайл-плоскость (битстрим v2). Ведёт реконструкцию для предикции.
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
    let mut recon = vec![0i16; w * h];
    let mut freq = [0f32; 64];
    let mut spatial = [0f32; 64];
    for by in 0..blocks_y {
        for bx in 0..blocks_x {
            let orig = gather_block_i32(buf, w, h, bx, by);
            let b = border(&recon, w, h, bx, by);
            let (mode, pred) = choose_mode(&orig, &b);
            syms.push((CTX_MODE, mode));

            let mut residual = [0f32; 64];
            for i in 0..64 {
                residual[i] = (orig[i] - pred[i]) as f32;
            }
            fdct8x8(&residual, &mut freq);
            let mut quantized = [0i32; 64];
            for (i, q) in quantized.iter_mut().enumerate() {
                *q = (freq[i] / f32::from(qmat[i])).round() as i32;
            }
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

/// Декодирует тайл-плоскость v2. Возвращает буфер отсчётов 0..=255.
pub fn decode_tile_plane(
    section: &Section<'_>,
    dec: &mut RansDecoder<'_>,
    raw: &mut BitReader<'_>,
    w: usize,
    h: usize,
    qmat: &[u16; 64],
) -> Result<Vec<i16>, DecodeError> {
    let blocks_x = w.div_ceil(8);
    let blocks_y = h.div_ceil(8);
    let mut recon = vec![0i16; w * h];
    let mut freq = [0f32; 64];
    let mut spatial = [0f32; 64];
    for by in 0..blocks_y {
        for bx in 0..blocks_x {
            let mode_sym = dec.get(&section.tables[usize::from(CTX_MODE)])?;
            if mode_sym >= N_MODES {
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
            let v = (residual[y * 8 + x] + pred[y * 8 + x] as f32).round().clamp(0.0, 255.0);
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
        write_dct_section(&mut out, N_CTX_V2, &syms, raw);

        let (section, used) = read_dct_section(&out, N_CTX_V2).unwrap();
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
        assert!(p90 > p30, "q=90 ({p90:.1} dB) должен быть точнее q=30 ({p30:.1} dB)");
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
        write_dct_section(&mut out, N_CTX_V2, &syms, raw);
        let (section, _) = read_dct_section(&out, N_CTX_V2).unwrap();
        let mut dec = RansDecoder::new(section.tokens).unwrap();
        let mut raw_reader = BitReader::new(section.raw);
        let decoded = decode_tile_plane(&section, &mut dec, &mut raw_reader, w, h, &qmat).unwrap();
        dec.finish().unwrap();
        assert!(psnr(&buf, &decoded) > 40.0);
        assert!(out.len() < 600, "градиент занял {} байт", out.len());
    }
}
