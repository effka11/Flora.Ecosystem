//! Декодер изображения. Контракт: любые входные байты → `Ok` или `Err`,
//! никаких паник; память аллоцируется только после проверки лимитов.

use crate::bits::BitReader;
use crate::color::{upsample_420, ycbcr_to_rgb, ycocg_r_to_rgb};
use crate::dct::{quant_matrix, BASE_CHROMA, BASE_LUMA};
use crate::error::DecodeError;
use crate::format::{tile_grid, Header, HEADER_LEN};
use crate::plane::{Plane, SampleRange, RANGE_CHROMA_LOSSLESS, RANGE_LUMA};
use crate::rans::RansDecoder;
use crate::section::read_section;
use crate::{lossless, lossy, DecodeLimits, DecodedImage, PixelFormat};

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
    let tiles = tile_grid(header.width, header.height);
    let table_len = tiles.len() * 4;
    let table_end = HEADER_LEN + table_len;
    let Some(table) = bytes.get(HEADER_LEN..table_end) else {
        return Err(DecodeError::Corrupt("обрыв таблицы тайлов"));
    };

    let mut p0 = Plane::new(w, h);
    let mut p1 = Plane::new(w, h);
    let mut p2 = Plane::new(w, h);
    let mut pa = header.alpha.then(|| Plane::new(w, h));

    let q_luma = quant_matrix(&BASE_LUMA, header.quality.max(1));
    let q_chroma = quant_matrix(&BASE_CHROMA, header.quality.max(1));

    let mut offset = table_end;
    for (i, t) in tiles.iter().enumerate() {
        let len = u32::from_le_bytes(table[i * 4..i * 4 + 4].try_into().expect("len 4")) as usize;
        let end = offset.checked_add(len).ok_or(DecodeError::Corrupt("переполнение смещения"))?;
        let Some(payload) = bytes.get(offset..end) else {
            return Err(DecodeError::Corrupt("обрыв данных тайла"));
        };
        offset = end;

        let mut pos = 0usize;
        if header.lossless {
            for (plane, range) in [
                (&mut p0, RANGE_LUMA),
                (&mut p1, RANGE_CHROMA_LOSSLESS),
                (&mut p2, RANGE_CHROMA_LOSSLESS),
            ] {
                let buf = read_lossless_plane(payload, &mut pos, t.w, t.h, range)?;
                plane.insert(t.x0, t.y0, t.w, t.h, &buf);
            }
        } else {
            let buf = read_dct_plane(payload, &mut pos, t.w, t.h, &q_luma)?;
            p0.insert(t.x0, t.y0, t.w, t.h, &buf);
            for plane in [&mut p1, &mut p2] {
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
                plane.insert(t.x0, t.y0, t.w, t.h, &full);
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

    // Обратное цветовое преобразование в интерливленный RGB(A).
    let format = if header.alpha { PixelFormat::Rgba8 } else { PixelFormat::Rgb8 };
    let bpp = if header.alpha { 4 } else { 3 };
    let mut data = vec![0u8; w * h * bpp];
    for i in 0..w * h {
        let (c0, c1, c2) = (i32::from(p0.data[i]), i32::from(p1.data[i]), i32::from(p2.data[i]));
        let (r, g, b) = if header.lossless {
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
    Ok(DecodedImage { width: header.width, height: header.height, format, data })
}

/// Читает одну lossless-секцию, полностью валидируя завершение потоков.
fn read_lossless_plane(
    payload: &[u8],
    pos: &mut usize,
    w: usize,
    h: usize,
    range: SampleRange,
) -> Result<Vec<i16>, DecodeError> {
    let (section, used) = read_section(&payload[*pos..], lossless::N_CTX)?;
    *pos += used;
    let mut dec = RansDecoder::new(section.tokens)?;
    let mut raw = BitReader::new(section.raw);
    let buf = lossless::decode_tile_plane(&section, &mut dec, &mut raw, w, h, range)?;
    dec.finish()?;
    if raw.unread_bytes() != 0 {
        return Err(DecodeError::Corrupt("лишние байты в потоке сырых бит"));
    }
    Ok(buf)
}

/// Читает одну DCT-секцию, полностью валидируя завершение потоков.
fn read_dct_plane(
    payload: &[u8],
    pos: &mut usize,
    w: usize,
    h: usize,
    qmat: &[u16; 64],
) -> Result<Vec<i16>, DecodeError> {
    let (section, used) = read_section(&payload[*pos..], lossy::N_CTX)?;
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
