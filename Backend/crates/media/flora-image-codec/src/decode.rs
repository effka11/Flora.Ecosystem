//! Декодер изображения. Контракт: любые входные байты → `Ok` или `Err`,
//! никаких паник; память аллоцируется только после проверки лимитов.

use crate::bits::BitReader;
use crate::color::{upsample_420, ycbcr_to_rgb, ycocg_r_to_rgb};
use crate::dct::{BASE_CHROMA, BASE_LUMA, quant_matrix};
use crate::error::DecodeError;
use crate::format::{HEADER_LEN, Header, tile_grid};
use crate::plane::{Plane, RANGE_CHROMA_LOSSLESS, RANGE_LUMA, SampleRange, palette_range};
use crate::rans::RansDecoder;
use crate::section::{PredictiveSection, read_dct_section, read_predictive_section, unpack_raw};
use crate::{DecodeLimits, DecodedImage, PixelFormat, lossless, lossy};

pub fn decode(bytes: &[u8], limits: DecodeLimits) -> Result<DecodedImage, DecodeError> {
    let header = Header::parse(bytes)?;
    let npix = u64::from(header.width) * u64::from(header.height);
    if npix > limits.max_pixels {
        return Err(DecodeError::TooLarge {
            width: header.width,
            height: header.height,
            max_pixels: limits.max_pixels,
        });
    }
    let (w, h) = (header.width as usize, header.height as usize);

    // Опциональный блок палитры сразу после заголовка.
    let mut offset = HEADER_LEN;
    let palette: Option<Vec<[u8; 4]>> = if header.palette {
        let Some(&count_minus_1) = bytes.get(offset) else {
            return Err(DecodeError::Corrupt("обрыв счётчика палитры"));
        };
        offset += 1;
        let count = usize::from(count_minus_1) + 1;
        let entry_len = header.palette_entry_len();
        let end = offset + count * entry_len;
        let Some(block) = bytes.get(offset..end) else {
            return Err(DecodeError::Corrupt("обрыв записей палитры"));
        };
        offset = end;
        Some(
            block
                .chunks_exact(entry_len)
                .map(|e| [e[0], e[1], e[2], if entry_len == 4 { e[3] } else { 255 }])
                .collect(),
        )
    } else {
        None
    };

    let tiles = tile_grid(header.width, header.height);
    let table_len = tiles.len() * 4;
    let table_end = offset
        .checked_add(table_len)
        .ok_or(DecodeError::Corrupt("переполнение таблицы"))?;
    let Some(table) = bytes.get(offset..table_end) else {
        return Err(DecodeError::Corrupt("обрыв таблицы тайлов"));
    };
    offset = table_end;

    // Плоскости: палитра — одна, иначе 3 (+ альфа).
    let n_color_planes = if palette.is_some() { 1 } else { 3 };
    let mut planes: Vec<Plane> = (0..n_color_planes).map(|_| Plane::new(w, h)).collect();
    let mut pa = (header.alpha && palette.is_none()).then(|| Plane::new(w, h));

    let q_luma = quant_matrix(&BASE_LUMA, header.quality.max(1));
    let q_chroma = quant_matrix(&BASE_CHROMA, header.quality.max(1));
    let chroma_range = if header.identity {
        RANGE_LUMA
    } else {
        RANGE_CHROMA_LOSSLESS
    };

    for (i, t) in tiles.iter().enumerate() {
        let len = u32::from_le_bytes(table[i * 4..i * 4 + 4].try_into().expect("len 4")) as usize;
        let end = offset
            .checked_add(len)
            .ok_or(DecodeError::Corrupt("переполнение смещения"))?;
        let Some(payload) = bytes.get(offset..end) else {
            return Err(DecodeError::Corrupt("обрыв данных тайла"));
        };
        offset = end;

        let mut pos = 0usize;
        if let Some(palette) = palette.as_ref() {
            let range = palette_range(palette.len());
            let buf = read_lossless_plane(payload, &mut pos, t.w, t.h, range)?;
            planes[0].insert(t.x0, t.y0, t.w, t.h, &buf);
        } else if header.lossless {
            for (idx, range) in [(0usize, RANGE_LUMA), (1, chroma_range), (2, chroma_range)] {
                let buf = read_lossless_plane(payload, &mut pos, t.w, t.h, range)?;
                planes[idx].insert(t.x0, t.y0, t.w, t.h, &buf);
            }
        } else {
            let buf = read_dct_plane(payload, &mut pos, t.w, t.h, &q_luma)?;
            planes[0].insert(t.x0, t.y0, t.w, t.h, &buf);
            for idx in [1usize, 2] {
                let (cw, ch) = if header.chroma420 {
                    (t.w.div_ceil(2), t.h.div_ceil(2))
                } else {
                    (t.w, t.h)
                };
                let cbuf = read_dct_plane(payload, &mut pos, cw, ch, &q_chroma)?;
                let full = if header.chroma420 {
                    upsample_420(&cbuf, cw, ch, t.w, t.h)
                } else {
                    cbuf
                };
                planes[idx].insert(t.x0, t.y0, t.w, t.h, &full);
            }
        }
        if let Some(pa) = pa.as_mut() {
            let buf = read_lossless_plane(payload, &mut pos, t.w, t.h, RANGE_LUMA)?;
            pa.insert(t.x0, t.y0, t.w, t.h, &buf);
        }
        if pos != payload.len() {
            return Err(DecodeError::Corrupt("лишние байты в тайле"));
        }
    }
    if offset != bytes.len() {
        return Err(DecodeError::Corrupt("лишние байты после последнего тайла"));
    }

    // Сборка интерливленного RGB(A).
    let format = if header.alpha {
        PixelFormat::Rgba8
    } else {
        PixelFormat::Rgb8
    };
    let bpp = if header.alpha { 4 } else { 3 };
    let mut data = vec![0u8; w * h * bpp];
    if let Some(palette) = palette.as_ref() {
        for i in 0..w * h {
            // Индекс валиден по построению: диапазон плоскости клампился
            // в 0..=len-1 при декодировании.
            let [r, g, b, a] = palette[planes[0].data[i] as usize];
            data[i * bpp] = r;
            data[i * bpp + 1] = g;
            data[i * bpp + 2] = b;
            if bpp == 4 {
                data[i * bpp + 3] = a;
            }
        }
    } else {
        for i in 0..w * h {
            let c0 = i32::from(planes[0].data[i]);
            let c1 = i32::from(planes[1].data[i]);
            let c2 = i32::from(planes[2].data[i]);
            let (r, g, b) = if header.identity {
                (c0, c1, c2)
            } else if header.lossless {
                let (r, g, b) = ycocg_r_to_rgb(c0, c1, c2);
                (r.clamp(0, 255), g.clamp(0, 255), b.clamp(0, 255))
            } else {
                ycbcr_to_rgb(c0, c1, c2)
            };
            data[i * bpp] = r as u8;
            data[i * bpp + 1] = g as u8;
            data[i * bpp + 2] = b as u8;
            if let Some(pa) = pa.as_ref() {
                data[i * bpp + 3] = pa.data[i].clamp(0, 255) as u8;
            }
        }
    }
    Ok(DecodedImage {
        width: header.width,
        height: header.height,
        format,
        data,
    })
}

/// Читает предиктивную секцию (coded либо raw), валидируя завершение потоков.
fn read_lossless_plane(
    payload: &[u8],
    pos: &mut usize,
    w: usize,
    h: usize,
    range: SampleRange,
) -> Result<Vec<i16>, DecodeError> {
    let (section, used) = read_predictive_section(&payload[*pos..], w, h, range)?;
    *pos += used;
    match section {
        PredictiveSection::Raw(packed) => unpack_raw(packed, w, h, range),
        PredictiveSection::Coded(section) => {
            let mut dec = RansDecoder::new(section.tokens)?;
            let mut raw = BitReader::new(section.raw);
            let buf = lossless::decode_tile_plane(&section, &mut dec, &mut raw, w, h, range)?;
            dec.finish()?;
            if raw.unread_bytes() != 0 {
                return Err(DecodeError::Corrupt("лишние байты в потоке сырых бит"));
            }
            Ok(buf)
        }
    }
}

/// Читает одну DCT-секцию, полностью валидируя завершение потоков.
fn read_dct_plane(
    payload: &[u8],
    pos: &mut usize,
    w: usize,
    h: usize,
    qmat: &[u16; 64],
) -> Result<Vec<i16>, DecodeError> {
    let (section, used) = read_dct_section(&payload[*pos..], lossy::N_CTX)?;
    *pos += used;
    let mut dec = RansDecoder::new(section.tokens)?;
    let mut raw = BitReader::new(section.raw);
    let buf = lossy::decode_tile_plane(&section, &mut dec, &mut raw, w, h, qmat)?;
    dec.finish()?;
    if raw.unread_bytes() != 0 {
        return Err(DecodeError::Corrupt("лишние байты в потоке сырых бит"));
    }
    Ok(buf)
}
