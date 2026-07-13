//! Lossless-кодер плоскости (FIC.md §5): MED-предиктор + контексты по
//! градиентам + hybrid-uint токены. Работает на одном тайле одной плоскости.
//!
//! Схема кодирования одинакова во всех версиях формата (v1..v3).
//! Классические добавки JPEG-LS (bias-коррекция LOCO-I, run-режим плоских
//! областей) были реализованы и измерены при разработке v2 — обе ухудшают
//! плотность на всём корпусе:
//! статическая rANS-таблица тайла и так поглощает стационарное смещение
//! остатков, а нулевые остатки кодирует почти бесплатно (доли миллибита),
//! тогда как run-токены несут несжимаемые сырые биты hybrid-uint.

use crate::bits::{BitReader, BitWriter};
use crate::error::DecodeError;
use crate::plane::PlaneShape;
use crate::predict::{N_CTX_LOSSLESS, grad_context, med, neighbors};
use crate::rans::RansDecoder;
use crate::section::Section;
use crate::tokens::{detokenize, tokenize, unzigzag, write_raw, zigzag};

/// Число контекстов lossless-плоскости (одинаково во всех версиях).
pub const N_CTX: usize = N_CTX_LOSSLESS;

/// Кодирует тайл-плоскость `w x h`, добавляя токены в `syms` и биты в `raw`.
pub fn encode_tile_plane(
    buf: &[i16],
    shape: PlaneShape,
    syms: &mut Vec<(u8, u8)>,
    raw: &mut BitWriter,
) {
    let (w, h) = (shape.w, shape.h);
    debug_assert_eq!(buf.len(), w * h);
    for y in 0..h {
        let (row, prev) = if y == 0 {
            (&buf[0..w], None)
        } else {
            (&buf[y * w..(y + 1) * w], Some(&buf[(y - 1) * w..y * w]))
        };
        for x in 0..w {
            let (west, north, north_west) = neighbors(row, prev, x, shape.range.mid);
            let ctx = grad_context(west, north, north_west);
            let pred = med(west, north, north_west);
            let residual = i32::from(row[x]) - pred;
            let (sym, bits, n_bits) = tokenize(zigzag(residual));
            syms.push((ctx as u8, sym));
            write_raw(raw, bits, n_bits);
        }
    }
}

/// Декодирует тайл-плоскость `w x h` из секции. Возвращает буфер отсчётов.
///
/// Восстановленное значение клампится в диапазон плоскости: повреждённый
/// поток даёт мусорное, но корректно ограниченное изображение без паник.
pub fn decode_tile_plane(
    section: &Section<'_>,
    dec: &mut RansDecoder<'_>,
    raw: &mut BitReader<'_>,
    shape: PlaneShape,
) -> Result<Vec<i16>, DecodeError> {
    let (w, h) = (shape.w, shape.h);
    let mut buf = vec![0i16; w * h];
    for y in 0..h {
        for x in 0..w {
            let (west, north, north_west) = {
                let (row, prev) = if y == 0 {
                    (&buf[0..w], None)
                } else {
                    (&buf[y * w..(y + 1) * w], Some(&buf[(y - 1) * w..y * w]))
                };
                neighbors(row, prev, x, shape.range.mid)
            };
            let ctx = grad_context(west, north, north_west);
            let pred = med(west, north, north_west);
            let sym = dec.get(&section.tables[ctx])?;
            let residual = unzigzag(detokenize(sym, raw)?);
            let value = (pred + residual).clamp(shape.range.lo, shape.range.hi);
            buf[y * w + x] = value as i16;
        }
    }
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plane::{RANGE_CHROMA_LOSSLESS, RANGE_LUMA, SampleRange};
    use crate::section::{
        PredictiveSection, read_predictive_section, unpack_raw, write_predictive_section,
    };

    fn roundtrip(buf: &[i16], w: usize, h: usize, range: SampleRange) {
        let shape = PlaneShape::new(w, h, range);
        let mut syms = Vec::new();
        let mut raw = BitWriter::new();
        encode_tile_plane(buf, shape, &mut syms, &mut raw);
        let mut out = Vec::new();
        write_predictive_section(&mut out, N_CTX, &syms, raw, buf, shape);

        let (section, used) = read_predictive_section(&out, N_CTX, shape).unwrap();
        assert_eq!(used, out.len());
        let decoded = match section {
            PredictiveSection::Raw(packed) => unpack_raw(packed, shape).unwrap(),
            PredictiveSection::Coded(section) => {
                let mut dec = RansDecoder::new(section.tokens).unwrap();
                let mut raw_reader = BitReader::new(section.raw);
                let decoded =
                    decode_tile_plane(&section, &mut dec, &mut raw_reader, shape).unwrap();
                dec.finish().unwrap();
                decoded
            }
        };
        assert_eq!(decoded, buf);
    }

    #[test]
    fn roundtrip_gradient_luma() {
        let (w, h) = (37, 23);
        let buf: Vec<i16> = (0..w * h)
            .map(|i| ((i % w) * 255 / w.max(1)) as i16)
            .collect();
        roundtrip(&buf, w, h, RANGE_LUMA);
    }

    #[test]
    fn roundtrip_noise_chroma() {
        let (w, h) = (16, 16);
        let mut seed = 0xDEAD_BEEFu64;
        let buf: Vec<i16> = (0..w * h)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                ((seed % 511) as i32 - 255) as i16
            })
            .collect();
        roundtrip(&buf, w, h, RANGE_CHROMA_LOSSLESS);
    }

    #[test]
    fn roundtrip_single_pixel() {
        roundtrip(&[42], 1, 1, RANGE_LUMA);
    }

    #[test]
    fn roundtrip_flat_and_striped() {
        let (w, h) = (64, 16);
        roundtrip(&vec![7i16; w * h], w, h, RANGE_LUMA);
        let stripes: Vec<i16> = (0..w * h)
            .map(|i| if (i % w) < 20 { 10 } else { 200 })
            .collect();
        roundtrip(&stripes, w, h, RANGE_LUMA);
    }
}
