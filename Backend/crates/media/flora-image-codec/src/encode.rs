//! Кодер изображения: план тайлов и плоскостей общий с декодером (FIC.md §3.4).

use crate::bits::BitWriter;
use crate::color::{downsample_420, rgb_to_ycbcr, rgb_to_ycocg_r};
use crate::dct::{quant_matrix, BASE_CHROMA, BASE_LUMA};
use crate::error::EncodeError;
use crate::format::{tile_grid, Header, DEFAULT_MAX_PIXELS, MAX_DIM};
use crate::plane::{Plane, SampleRange, RANGE_CHROMA_LOSSLESS, RANGE_LUMA};
use crate::section::write_section;
use crate::{lossless, lossy, EncodeMode, ImageView, PixelFormat};

/// Порог качества, ниже которого включается сабсэмплинг цветоразностей 4:2:0.
const CHROMA420_MAX_QUALITY: u8 = 85;

pub fn encode(img: &ImageView<'_>, mode: EncodeMode) -> Result<Vec<u8>, EncodeError> {
    let (width, height) = (img.width, img.height);
    let too_big = u64::from(width) * u64::from(height) > DEFAULT_MAX_PIXELS;
    if width == 0 || height == 0 || width > MAX_DIM || height > MAX_DIM || too_big {
        return Err(EncodeError::InvalidDimensions { width, height });
    }
    let bpp = match img.format {
        PixelFormat::Rgb8 => 3,
        PixelFormat::Rgba8 => 4,
    };
    let (w, h) = (width as usize, height as usize);
    let expected = w * h * bpp;
    if img.data.len() != expected {
        return Err(EncodeError::BufferSizeMismatch { expected, actual: img.data.len() });
    }
    let quality = match mode {
        EncodeMode::Lossless => 0,
        EncodeMode::Lossy { quality } => {
            if !(1..=100).contains(&quality) {
                return Err(EncodeError::InvalidQuality(quality));
            }
            quality
        }
    };
    let lossless_mode = matches!(mode, EncodeMode::Lossless);
    let alpha = matches!(img.format, PixelFormat::Rgba8);
    let header = Header {
        width,
        height,
        lossless: lossless_mode,
        alpha,
        chroma420: !lossless_mode && quality <= CHROMA420_MAX_QUALITY,
        quality,
    };

    // Полноразмерные плоскости выбранного цветового пространства.
    let mut p0 = Plane::new(w, h); // Y
    let mut p1 = Plane::new(w, h); // Co | Cb
    let mut p2 = Plane::new(w, h); // Cg | Cr
    let mut pa = alpha.then(|| Plane::new(w, h));
    for i in 0..w * h {
        let px = &img.data[i * bpp..i * bpp + bpp];
        let (r, g, b) = (i32::from(px[0]), i32::from(px[1]), i32::from(px[2]));
        let (c0, c1, c2) =
            if lossless_mode { rgb_to_ycocg_r(r, g, b) } else { rgb_to_ycbcr(r, g, b) };
        p0.data[i] = c0 as i16;
        p1.data[i] = c1 as i16;
        p2.data[i] = c2 as i16;
        if let Some(pa) = pa.as_mut() {
            pa.data[i] = i16::from(px[3]);
        }
    }

    let q_luma = quant_matrix(&BASE_LUMA, quality.max(1));
    let q_chroma = quant_matrix(&BASE_CHROMA, quality.max(1));

    let tiles = tile_grid(width, height);
    let mut payloads: Vec<Vec<u8>> = Vec::with_capacity(tiles.len());
    for t in &tiles {
        let mut payload = Vec::new();
        if lossless_mode {
            for (plane, range) in [
                (&p0, RANGE_LUMA),
                (&p1, RANGE_CHROMA_LOSSLESS),
                (&p2, RANGE_CHROMA_LOSSLESS),
            ] {
                let buf = plane.extract(t.x0, t.y0, t.w, t.h);
                write_lossless_section(&mut payload, &buf, t.w, t.h, range);
            }
        } else {
            let buf = p0.extract(t.x0, t.y0, t.w, t.h);
            write_dct_section(&mut payload, &buf, t.w, t.h, &q_luma);
            for plane in [&p1, &p2] {
                let full = plane.extract(t.x0, t.y0, t.w, t.h);
                let (cbuf, cw, ch) = if header.chroma420 {
                    (downsample_420(&full, t.w, t.h), t.w.div_ceil(2), t.h.div_ceil(2))
                } else {
                    (full, t.w, t.h)
                };
                write_dct_section(&mut payload, &cbuf, cw, ch, &q_chroma);
            }
        }
        if let Some(pa) = pa.as_ref() {
            let buf = pa.extract(t.x0, t.y0, t.w, t.h);
            write_lossless_section(&mut payload, &buf, t.w, t.h, RANGE_LUMA);
        }
        payloads.push(payload);
    }

    let table_len = payloads.len() * 4;
    let body_len: usize = payloads.iter().map(Vec::len).sum();
    let mut out = Vec::with_capacity(crate::format::HEADER_LEN + table_len + body_len);
    out.extend_from_slice(&header.serialize());
    for payload in &payloads {
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    }
    for payload in &payloads {
        out.extend_from_slice(payload);
    }
    Ok(out)
}

fn write_lossless_section(out: &mut Vec<u8>, buf: &[i16], w: usize, h: usize, range: SampleRange) {
    let mut syms = Vec::new();
    let mut raw = BitWriter::new();
    lossless::encode_tile_plane(buf, w, h, range, &mut syms, &mut raw);
    write_section(out, lossless::N_CTX, &syms, raw);
}

fn write_dct_section(out: &mut Vec<u8>, buf: &[i16], w: usize, h: usize, qmat: &[u16; 64]) {
    let mut syms = Vec::new();
    let mut raw = BitWriter::new();
    lossy::encode_tile_plane(buf, w, h, qmat, &mut syms, &mut raw);
    write_section(out, lossy::N_CTX, &syms, raw);
}
