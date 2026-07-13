//! Lossless-кодер плоскости (FIC.md §5): MED-предиктор + контексты по
//! градиентам + hybrid-uint токены. Работает на одном тайле одной плоскости.
//!
//! v2 добавляет **bias-коррекцию** предсказания по контексту (схема
//! LOCO-I / JPEG-LS): счётчики `N`/`B` копят систематическую ошибку MED
//! в контексте, поправка `C` сдвигает предсказание. Кодер и декодер гоняют
//! один и тот же автомат [`BiasTracker`] по одинаковым данным — расхождение
//! исключено. v1-потоки декодируются без коррекции.
//!
//! Run-режим здесь сознательно отсутствует: rANS кодирует нулевые остатки
//! в контексте почти бесплатно (доли промилле бита на токен), а run-токен
//! нёс бы несжимаемые сырые биты hybrid-uint — на плоских областях это
//! дороже, чем поток нулей (проверено бенчмарком).

use crate::bits::{BitReader, BitWriter};
use crate::error::DecodeError;
use crate::plane::PlaneShape;
use crate::predict::{N_CTX_LOSSLESS, grad_context, med, neighbors};
use crate::rans::RansDecoder;
use crate::section::Section;
use crate::tokens::{detokenize, tokenize, unzigzag, write_raw, zigzag};

/// Число контекстов lossless-плоскости (общее для v1 и v2).
pub const N_CTX: usize = N_CTX_LOSSLESS;

/// Порог половинения счётчиков bias-коррекции (окно адаптации, как в JPEG-LS).
const BIAS_RESET: i32 = 64;

/// Автомат bias-коррекции per-context. Общий для кодера и декодера.
struct BiasTracker {
    n: [i32; N_CTX_LOSSLESS],
    b: [i32; N_CTX_LOSSLESS],
    c: [i32; N_CTX_LOSSLESS],
}

impl BiasTracker {
    fn new() -> Self {
        Self { n: [0; N_CTX_LOSSLESS], b: [0; N_CTX_LOSSLESS], c: [0; N_CTX_LOSSLESS] }
    }

    /// Текущая поправка предсказания в контексте.
    #[inline]
    fn correction(&self, ctx: usize) -> i32 {
        self.c[ctx]
    }

    /// Учитывает ошибку `err` (после поправки) и адаптирует `C` (LOCO-I).
    ///
    /// Все операции целочисленные; половинение — арифметический сдвиг
    /// (округление к минус-бесконечности). `C` ограничен ±128.
    #[inline]
    fn update(&mut self, ctx: usize, err: i32) {
        self.b[ctx] += err;
        self.n[ctx] += 1;
        if self.n[ctx] >= BIAS_RESET {
            self.n[ctx] >>= 1;
            self.b[ctx] >>= 1;
        }
        if self.b[ctx] <= -self.n[ctx] {
            self.c[ctx] = (self.c[ctx] - 1).max(-128);
            self.b[ctx] += self.n[ctx];
            if self.b[ctx] <= -self.n[ctx] {
                self.b[ctx] = -self.n[ctx] + 1;
            }
        } else if self.b[ctx] > 0 {
            self.c[ctx] = (self.c[ctx] + 1).min(128);
            self.b[ctx] -= self.n[ctx];
            if self.b[ctx] > 0 {
                self.b[ctx] = 0;
            }
        }
    }
}

/// Сосед NE (north-east) — условие входа в run-режим.
#[inline]
fn north_east(prev: Option<&[i16]>, x: usize, w: usize, north: i32) -> i32 {
    match prev {
        Some(p) if x + 1 < w => i32::from(p[x + 1]),
        _ => north,
    }
}

/// Кодирует тайл-плоскость (битстрим v2).
pub fn encode_tile_plane(
    buf: &[i16],
    shape: PlaneShape,
    syms: &mut Vec<(u8, u8)>,
    raw: &mut BitWriter,
) {
    let (w, h) = (shape.w, shape.h);
    debug_assert_eq!(buf.len(), w * h);
    let mut bias = BiasTracker::new();
    for y in 0..h {
        let (row, prev) = if y == 0 {
            (&buf[0..w], None)
        } else {
            (&buf[y * w..(y + 1) * w], Some(&buf[(y - 1) * w..y * w]))
        };
        let mut x = 0usize;
        while x < w {
            let (mut west, mut north, mut north_west) = neighbors(row, prev, x, shape.range.mid);
            let flat = west == north
                && north == north_west
                && north == north_east(prev, x, w, north);
            if flat {
                // Максимальная серия отсчётов, равных W, до конца строки.
                let mut run = 0usize;
                while x + run < w && i32::from(row[x + run]) == west {
                    run += 1;
                }
                let (sym, bits, n_bits) = tokenize(run as u32);
                syms.push((CTX_RUN as u8, sym));
                write_raw(raw, bits, n_bits);
                x += run;
                if x >= w {
                    break;
                }
                // Отсчёт, прервавший серию, кодируется обычным путём
                // с соседями своей позиции.
                (west, north, north_west) = neighbors(row, prev, x, shape.range.mid);
            }
            let ctx = grad_context(west, north, north_west);
            let pred = (med(west, north, north_west) + bias.correction(ctx))
                .clamp(shape.range.lo, shape.range.hi);
            let err = i32::from(row[x]) - pred;
            let (sym, bits, n_bits) = tokenize(zigzag(err));
            syms.push((ctx as u8, sym));
            write_raw(raw, bits, n_bits);
            bias.update(ctx, err);
            x += 1;
        }
    }
}

/// Декодирует тайл-плоскость битстрима версии `version` (1 или 2).
///
/// Восстановленное значение клампится в диапазон плоскости: повреждённый
/// поток даёт мусорное, но корректно ограниченное изображение без паник.
pub fn decode_tile_plane(
    section: &Section<'_>,
    dec: &mut RansDecoder<'_>,
    raw: &mut BitReader<'_>,
    shape: PlaneShape,
    version: u8,
) -> Result<Vec<i16>, DecodeError> {
    let (w, h) = (shape.w, shape.h);
    let v2 = version >= 2;
    let mut bias = BiasTracker::new();
    let mut buf = vec![0i16; w * h];
    for y in 0..h {
        let mut x = 0usize;
        while x < w {
            let (mut west, mut north, mut north_west) =
                split_neighbors(&buf, w, x, y, shape.range.mid);
            if v2 {
                let ne = if y > 0 && x + 1 < w {
                    i32::from(buf[(y - 1) * w + x + 1])
                } else {
                    north
                };
                if west == north && north == north_west && north == ne {
                    let sym = dec.get(&section.tables[CTX_RUN])?;
                    let run = detokenize(sym, raw)? as usize;
                    if run > w - x {
                        return Err(DecodeError::Corrupt("lossless: серия за концом строки"));
                    }
                    for i in 0..run {
                        buf[y * w + x + i] = west as i16;
                    }
                    x += run;
                    if x >= w {
                        break;
                    }
                    (west, north, north_west) = split_neighbors(&buf, w, x, y, shape.range.mid);
                }
            }
            let ctx = grad_context(west, north, north_west);
            let mut pred = med(west, north, north_west);
            if v2 {
                pred = (pred + bias.correction(ctx)).clamp(shape.range.lo, shape.range.hi);
            }
            let sym = dec.get(&section.tables[ctx])?;
            let err = unzigzag(detokenize(sym, raw)?);
            let value = (pred + err).clamp(shape.range.lo, shape.range.hi);
            buf[y * w + x] = value as i16;
            if v2 {
                bias.update(ctx, err);
            }
            x += 1;
        }
    }
    Ok(buf)
}

/// Соседи по общему буферу декодера (текущая строка заполнена до `x`).
#[inline]
fn split_neighbors(buf: &[i16], w: usize, x: usize, y: usize, mid: i32) -> (i32, i32, i32) {
    let (row, prev) = if y == 0 {
        (&buf[0..w], None)
    } else {
        (&buf[y * w..(y + 1) * w], Some(&buf[(y - 1) * w..y * w]))
    };
    neighbors(row, prev, x, mid)
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
        write_predictive_section(&mut out, N_CTX_V2, &syms, raw, buf, shape);

        let (section, used) = read_predictive_section(&out, N_CTX_V2, shape).unwrap();
        assert_eq!(used, out.len());
        let decoded = match section {
            PredictiveSection::Raw(packed) => unpack_raw(packed, shape).unwrap(),
            PredictiveSection::Coded(section) => {
                let mut dec = RansDecoder::new(section.tokens).unwrap();
                let mut raw_reader = BitReader::new(section.raw);
                let decoded =
                    decode_tile_plane(&section, &mut dec, &mut raw_reader, shape, 2).unwrap();
                dec.finish().unwrap();
                decoded
            }
        };
        assert_eq!(decoded, buf);
    }

    #[test]
    fn roundtrip_gradient_luma() {
        let (w, h) = (37, 23);
        let buf: Vec<i16> = (0..w * h).map(|i| ((i % w) * 255 / w.max(1)) as i16).collect();
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
    fn roundtrip_flat_and_striped_uses_runs() {
        // Плоская заливка: количество токенов должно рухнуть до ~1 на строку.
        let (w, h) = (64, 16);
        let flat = vec![7i16; w * h];
        let shape = PlaneShape::new(w, h, RANGE_LUMA);
        let mut syms = Vec::new();
        let mut raw = BitWriter::new();
        encode_tile_plane(&flat, shape, &mut syms, &mut raw);
        assert!(syms.len() <= 2 * h, "плоская заливка дала {} токенов", syms.len());
        roundtrip(&flat, w, h, RANGE_LUMA);

        // Полосы, ломающие серии на границах.
        let stripes: Vec<i16> =
            (0..w * h).map(|i| if (i % w) < 20 { 10 } else { 200 }).collect();
        roundtrip(&stripes, w, h, RANGE_LUMA);
    }

    #[test]
    fn roundtrip_gradient_with_bias() {
        // Наклонный градиент с постоянным дрейфом — цель bias-коррекции.
        let (w, h) = (48, 48);
        let buf: Vec<i16> =
            (0..w * h).map(|i| (((i % w) + (i / w) * 2) % 256) as i16).collect();
        roundtrip(&buf, w, h, RANGE_LUMA);
    }
}
