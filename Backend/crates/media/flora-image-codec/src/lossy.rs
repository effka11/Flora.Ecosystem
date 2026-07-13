//! Lossy-кодер плоскости (FIC.md §7): DCT 8x8, перцептивное квантование,
//! DC-предсказание от предыдущего блока, run/level кодирование AC-коэффициентов.

use crate::bits::{BitReader, BitWriter};
use crate::dct::{ZIGZAG, fdct8x8, idct8x8};
use crate::error::DecodeError;
use crate::rans::RansDecoder;
use crate::section::Section;
use crate::tokens::{detokenize, tokenize, unzigzag, write_raw, zigzag};

/// Контексты DCT-плоскости: DC, run (низкие/высокие частоты), level (низкие/высокие).
pub const N_CTX: usize = 5;
const CTX_DC: u8 = 0;
const CTX_RUN_LOW: u8 = 1;
const CTX_RUN_HIGH: u8 = 2;
const CTX_LEVEL_LOW: u8 = 3;
const CTX_LEVEL_HIGH: u8 = 4;
/// Символ конца блока в run-контекстах (run <= 62 занимает символы <= 17).
const EOB_SYM: u8 = 31;
/// Граница низкочастотной зоны зигзага.
const LOW_BAND_END: usize = 15;

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

/// Собирает блок 8x8 с репликацией краёв и центрированием (-128).
fn gather_block(buf: &[i16], w: usize, h: usize, bx: usize, by: usize) -> [f32; 64] {
    let mut block = [0f32; 64];
    for y in 0..8 {
        let sy = (by * 8 + y).min(h - 1);
        for x in 0..8 {
            let sx = (bx * 8 + x).min(w - 1);
            block[y * 8 + x] = f32::from(buf[sy * w + sx]) - 128.0;
        }
    }
    block
}

/// Кодирует тайл-плоскость `w x h` с матрицей квантования `qmat`.
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
    let mut prev_dc: i32 = 0;
    let mut freq = [0f32; 64];
    for by in 0..blocks_y {
        for bx in 0..blocks_x {
            let block = gather_block(buf, w, h, bx, by);
            fdct8x8(&block, &mut freq);

            let mut quantized = [0i32; 64];
            for (i, q) in quantized.iter_mut().enumerate() {
                *q = (freq[i] / f32::from(qmat[i])).round() as i32;
            }

            // DC: разность с предыдущим блоком.
            let dc = quantized[0];
            let (sym, bits, n_bits) = tokenize(zigzag(dc - prev_dc));
            syms.push((CTX_DC, sym));
            write_raw(raw, bits, n_bits);
            prev_dc = dc;

            // AC: run/level по зигзагу, EOB при хвосте нулей.
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
    }
}

/// Декодирует тайл-плоскость `w x h`. Возвращает буфер отсчётов 0..=255.
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
    let mut buf = vec![0i16; w * h];
    let mut prev_dc: i32 = 0;
    let mut freq = [0f32; 64];
    let mut spatial = [0f32; 64];
    for by in 0..blocks_y {
        for bx in 0..blocks_x {
            freq.fill(0.0);

            let dc_sym = dec.get(&section.tables[usize::from(CTX_DC)])?;
            let dc = prev_dc.wrapping_add(unzigzag(detokenize(dc_sym, raw)?));
            prev_dc = dc;
            freq[0] = dc as f32 * f32::from(qmat[0]);

            let mut pos = 1usize;
            while pos < 64 {
                let rsym = dec.get(&section.tables[usize::from(run_ctx(pos))])?;
                if rsym == EOB_SYM {
                    break;
                }
                let run = detokenize(rsym, raw)? as usize;
                pos = pos
                    .checked_add(run)
                    .ok_or(DecodeError::Corrupt("dct: run overflow"))?;
                if pos >= 64 {
                    return Err(DecodeError::Corrupt("dct: позиция AC вне блока"));
                }
                let lsym = dec.get(&section.tables[usize::from(level_ctx(pos))])?;
                let magnitude = detokenize(lsym, raw)?.wrapping_add(1) as i32;
                let sign = raw.read(1)?;
                let level = if sign == 1 { -magnitude } else { magnitude };
                freq[ZIGZAG[pos]] = level as f32 * f32::from(qmat[ZIGZAG[pos]]);
                pos += 1;
            }

            idct8x8(&freq, &mut spatial);
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
                    let v = (spatial[y * 8 + x] + 128.0).round().clamp(0.0, 255.0);
                    buf[sy * w + sx] = v as i16;
                }
            }
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
        write_dct_section(&mut out, N_CTX, &syms, raw);

        let (section, used) = read_dct_section(&out, N_CTX).unwrap();
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
}
