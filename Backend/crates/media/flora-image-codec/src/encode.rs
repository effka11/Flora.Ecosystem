//! Кодер изображения: план тайлов и плоскостей общий с декодером (FIC.md §2.4).
//!
//! Выбор инструментов внутри lossless — за кодером (палитра, identity vs
//! YCoCg-R, raw-fallback секций): декодер читает любой корректный поток,
//! поэтому эвристики можно улучшать без изменения формата.

use crate::bits::BitWriter;
use crate::color::{downsample_420, rgb_to_ycbcr, rgb_to_ycocg_r};
use crate::dct::{BASE_CHROMA, BASE_LUMA, quant_matrix};
use crate::error::EncodeError;
use crate::format::{DEFAULT_MAX_PIXELS, HEADER_LEN, Header, MAX_DIM, MAX_PALETTE, tile_grid};
use crate::plane::{Plane, RANGE_CHROMA_LOSSLESS, RANGE_LUMA, SampleRange, palette_range};
use crate::predict::med;
use crate::section::{write_dct_section, write_predictive_section};
use crate::tokens::{tokenize, zigzag};
use crate::{EncodeMode, ImageView, PixelFormat, lossless, lossy};
use std::collections::HashMap;

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
        return Err(EncodeError::BufferSizeMismatch {
            expected,
            actual: img.data.len(),
        });
    }

    match mode {
        EncodeMode::Lossless => {
            let planar = encode_lossless_planar(img, choose_identity(img, bpp));
            Ok(match try_encode_palette(img, bpp) {
                Some(palette) if palette.len() < planar.len() => palette,
                _ => planar,
            })
        }
        EncodeMode::Lossy { quality } => {
            if !(1..=100).contains(&quality) {
                return Err(EncodeError::InvalidQuality(quality));
            }
            let dct = encode_lossy(img, bpp, quality);
            // Малоцветные изображения (графика, скриншоты): lossless-палитра
            // может быть одновременно меньше и точнее DCT — тогда она и уходит.
            Ok(match try_encode_palette(img, bpp) {
                Some(palette) if palette.len() < dct.len() => palette,
                _ => dct,
            })
        }
    }
}

// --- сборка контейнера -------------------------------------------------------

fn assemble(header: &Header, palette_block: Option<&[u8]>, payloads: &[Vec<u8>]) -> Vec<u8> {
    let body_len: usize = payloads.iter().map(Vec::len).sum();
    let palette_len = palette_block.map_or(0, <[u8]>::len);
    let mut out = Vec::with_capacity(HEADER_LEN + palette_len + payloads.len() * 4 + body_len);
    out.extend_from_slice(&header.serialize());
    if let Some(block) = palette_block {
        out.extend_from_slice(block);
    }
    for payload in payloads {
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    }
    for payload in payloads {
        out.extend_from_slice(payload);
    }
    out
}

fn plane_payload(buf: &[i16], w: usize, h: usize, range: SampleRange, out: &mut Vec<u8>) {
    let mut syms = Vec::new();
    let mut raw = BitWriter::new();
    lossless::encode_tile_plane(buf, w, h, range, &mut syms, &mut raw);
    write_predictive_section(out, &syms, raw, buf, w, h, range);
}

// --- lossless: планарный (YCoCg-R либо identity RGB) --------------------------

fn encode_lossless_planar(img: &ImageView<'_>, identity: bool) -> Vec<u8> {
    let (w, h) = (img.width as usize, img.height as usize);
    let bpp = if matches!(img.format, PixelFormat::Rgba8) {
        4
    } else {
        3
    };
    let alpha = bpp == 4;

    let mut p0 = Plane::new(w, h);
    let mut p1 = Plane::new(w, h);
    let mut p2 = Plane::new(w, h);
    let mut pa = alpha.then(|| Plane::new(w, h));
    for i in 0..w * h {
        let px = &img.data[i * bpp..i * bpp + bpp];
        let (r, g, b) = (i32::from(px[0]), i32::from(px[1]), i32::from(px[2]));
        let (c0, c1, c2) = if identity {
            (r, g, b)
        } else {
            rgb_to_ycocg_r(r, g, b)
        };
        p0.data[i] = c0 as i16;
        p1.data[i] = c1 as i16;
        p2.data[i] = c2 as i16;
        if let Some(pa) = pa.as_mut() {
            pa.data[i] = i16::from(px[3]);
        }
    }
    let chroma_range = if identity {
        RANGE_LUMA
    } else {
        RANGE_CHROMA_LOSSLESS
    };

    let header = Header {
        width: img.width,
        height: img.height,
        lossless: true,
        alpha,
        chroma420: false,
        identity,
        palette: false,
        quality: 0,
    };
    let tiles = tile_grid(img.width, img.height);
    let mut payloads = Vec::with_capacity(tiles.len());
    for t in &tiles {
        let mut payload = Vec::new();
        for (plane, range) in [(&p0, RANGE_LUMA), (&p1, chroma_range), (&p2, chroma_range)] {
            let buf = plane.extract(t.x0, t.y0, t.w, t.h);
            plane_payload(&buf, t.w, t.h, range, &mut payload);
        }
        if let Some(pa) = pa.as_ref() {
            let buf = pa.extract(t.x0, t.y0, t.w, t.h);
            plane_payload(&buf, t.w, t.h, RANGE_LUMA, &mut payload);
        }
        payloads.push(payload);
    }
    assemble(&header, None, &payloads)
}

/// Оценщик: identity выгоднее YCoCg-R? Считает по субвыборке пикселей
/// оценку стоимости (энтропия токенов + сырые биты) обоих пространств.
fn choose_identity(img: &ImageView<'_>, bpp: usize) -> bool {
    let (w, h) = (img.width as usize, img.height as usize);
    // Шаг подвыборки: ~64k пикселей достаточно для устойчивой оценки.
    let step = (((w * h) as f64 / 65_536.0).sqrt().ceil() as usize).max(1);

    // Гистограммы токенов остатков: [пространство][канал][символ].
    let mut hists = [[[0u64; 32]; 3]; 2];
    let mut raw_bits = [[0u64; 3]; 2];
    let mut samples = 0u64;

    let px = |x: usize, y: usize| -> (i32, i32, i32) {
        let p = &img.data[(y * w + x) * bpp..(y * w + x) * bpp + 3];
        (i32::from(p[0]), i32::from(p[1]), i32::from(p[2]))
    };
    for y in (1..h).step_by(step) {
        for x in (1..w).step_by(step) {
            let cur = px(x, y);
            let west = px(x - 1, y);
            let north = px(x, y - 1);
            let north_west = px(x - 1, y - 1);
            for (space, transform) in [identity_transform, ycocg_transform]
                .into_iter()
                .enumerate()
            {
                let c = transform(cur);
                let cw = transform(west);
                let cn = transform(north);
                let cnw = transform(north_west);
                for (ch, (v, wv, nv, nwv)) in [
                    (c.0, cw.0, cn.0, cnw.0),
                    (c.1, cw.1, cn.1, cnw.1),
                    (c.2, cw.2, cn.2, cnw.2),
                ]
                .into_iter()
                .enumerate()
                {
                    let residual = v - med(wv, nv, nwv);
                    let (sym, _, n_bits) = tokenize(zigzag(residual));
                    hists[space][ch][usize::from(sym)] += 1;
                    raw_bits[space][ch] += u64::from(n_bits);
                }
            }
            samples += 1;
        }
    }
    if samples < 64 {
        return false; // мало данных — YCoCg-R по умолчанию
    }
    // Стоимость канала: энтропия токенов + сырые биты, но не больше потолка
    // raw-fallback секции (кодер выберет его при некомпрессируемости).
    let cost = |space: usize, ch: usize, ceiling_bits: f64| -> f64 {
        let hist = &hists[space][ch];
        let total: u64 = hist.iter().sum();
        let mut bits = raw_bits[space][ch] as f64;
        for &n in hist.iter().filter(|&&n| n > 0) {
            let p = n as f64 / total as f64;
            bits += n as f64 * -p.log2();
        }
        bits.min(total as f64 * ceiling_bits)
    };
    // Потолки: identity — 8 бит/канал; YCoCg-R — 8 (Y) и 9 (Co/Cg).
    let identity_cost: f64 = (0..3).map(|ch| cost(0, ch, 8.0)).sum();
    let ycocg_cost: f64 = cost(1, 0, 8.0) + cost(1, 1, 9.0) + cost(1, 2, 9.0);
    // Лёгкий уклон к YCoCg-R: при почти равной оценке он надёжнее на фото.
    identity_cost < ycocg_cost * 0.98
}

fn identity_transform(rgb: (i32, i32, i32)) -> (i32, i32, i32) {
    rgb
}

fn ycocg_transform((r, g, b): (i32, i32, i32)) -> (i32, i32, i32) {
    rgb_to_ycocg_r(r, g, b)
}

// --- lossless: палитра ---------------------------------------------------------

/// Ключ палитры: RGBA (для RGB альфа = 255).
fn palette_key(px: &[u8], bpp: usize) -> [u8; 4] {
    [px[0], px[1], px[2], if bpp == 4 { px[3] } else { 255 }]
}

fn try_encode_palette(img: &ImageView<'_>, bpp: usize) -> Option<Vec<u8>> {
    let (w, h) = (img.width as usize, img.height as usize);
    let mut order: HashMap<[u8; 4], u16> = HashMap::with_capacity(MAX_PALETTE * 2);
    for px in img.data.chunks_exact(bpp) {
        let key = palette_key(px, bpp);
        let next = order.len() as u16;
        order.entry(key).or_insert(next);
        if order.len() > MAX_PALETTE {
            return None;
        }
    }
    // Сортировка по яркости: перцептивно близкие цвета получают соседние
    // индексы — MED-предсказание индексов начинает работать.
    let mut entries: Vec<[u8; 4]> = order.keys().copied().collect();
    entries.sort_by_key(|&[r, g, b, a]| {
        let luma = 299 * u32::from(r) + 587 * u32::from(g) + 114 * u32::from(b);
        (luma, r, g, b, a)
    });
    let index_of: HashMap<[u8; 4], u16> = entries
        .iter()
        .enumerate()
        .map(|(i, &k)| (k, i as u16))
        .collect();

    let count = entries.len().max(1);
    let mut indices = Plane::new(w, h);
    for (i, px) in img.data.chunks_exact(bpp).enumerate() {
        indices.data[i] = index_of[&palette_key(px, bpp)] as i16;
    }

    let alpha = matches!(img.format, PixelFormat::Rgba8);
    let header = Header {
        width: img.width,
        height: img.height,
        lossless: true,
        alpha,
        chroma420: false,
        identity: false,
        palette: true,
        quality: 0,
    };
    let range = palette_range(count);

    let mut block = Vec::with_capacity(1 + count * header.palette_entry_len());
    block.push((count - 1) as u8);
    for &[r, g, b, a] in &entries {
        if alpha {
            block.extend_from_slice(&[r, g, b, a]);
        } else {
            block.extend_from_slice(&[r, g, b]);
        }
    }

    let tiles = tile_grid(img.width, img.height);
    let mut payloads = Vec::with_capacity(tiles.len());
    for t in &tiles {
        let mut payload = Vec::new();
        let buf = indices.extract(t.x0, t.y0, t.w, t.h);
        plane_payload(&buf, t.w, t.h, range, &mut payload);
        payloads.push(payload);
    }
    Some(assemble(&header, Some(&block), &payloads))
}

// --- lossy: DCT ----------------------------------------------------------------

fn encode_lossy(img: &ImageView<'_>, bpp: usize, quality: u8) -> Vec<u8> {
    let (w, h) = (img.width as usize, img.height as usize);
    let alpha = bpp == 4;
    let header = Header {
        width: img.width,
        height: img.height,
        lossless: false,
        alpha,
        chroma420: quality <= CHROMA420_MAX_QUALITY,
        identity: false,
        palette: false,
        quality,
    };

    let mut p0 = Plane::new(w, h);
    let mut p1 = Plane::new(w, h);
    let mut p2 = Plane::new(w, h);
    let mut pa = alpha.then(|| Plane::new(w, h));
    for i in 0..w * h {
        let px = &img.data[i * bpp..i * bpp + bpp];
        let (y, cb, cr) = rgb_to_ycbcr(i32::from(px[0]), i32::from(px[1]), i32::from(px[2]));
        p0.data[i] = y as i16;
        p1.data[i] = cb as i16;
        p2.data[i] = cr as i16;
        if let Some(pa) = pa.as_mut() {
            pa.data[i] = i16::from(px[3]);
        }
    }

    let q_luma = quant_matrix(&BASE_LUMA, quality);
    let q_chroma = quant_matrix(&BASE_CHROMA, quality);

    let tiles = tile_grid(img.width, img.height);
    let mut payloads = Vec::with_capacity(tiles.len());
    for t in &tiles {
        let mut payload = Vec::new();
        let buf = p0.extract(t.x0, t.y0, t.w, t.h);
        dct_payload(&buf, t.w, t.h, &q_luma, &mut payload);
        for plane in [&p1, &p2] {
            let full = plane.extract(t.x0, t.y0, t.w, t.h);
            let (cbuf, cw, ch) = if header.chroma420 {
                (
                    downsample_420(&full, t.w, t.h),
                    t.w.div_ceil(2),
                    t.h.div_ceil(2),
                )
            } else {
                (full, t.w, t.h)
            };
            dct_payload(&cbuf, cw, ch, &q_chroma, &mut payload);
        }
        if let Some(pa) = pa.as_ref() {
            let buf = pa.extract(t.x0, t.y0, t.w, t.h);
            plane_payload(&buf, t.w, t.h, RANGE_LUMA, &mut payload);
        }
        payloads.push(payload);
    }
    assemble(&header, None, &payloads)
}

fn dct_payload(buf: &[i16], w: usize, h: usize, qmat: &[u16; 64], out: &mut Vec<u8>) {
    let mut syms = Vec::new();
    let mut raw = BitWriter::new();
    lossy::encode_tile_plane(buf, w, h, qmat, &mut syms, &mut raw);
    write_dct_section(out, lossy::N_CTX, &syms, raw);
}
