//! Кодер изображения: план тайлов и плоскостей общий с декодером (FRC-I.md §2.4).
//!
//! Выбор инструментов внутри lossless — за кодером (палитра, identity vs
//! YCoCg-R, raw-fallback секций): декодер читает любой корректный поток,
//! поэтому эвристики можно улучшать без изменения формата.

use crate::bits::BitWriter;
use crate::color::{downsample_420, rgb_to_ycbcr, rgb_to_ycocg_r};
use crate::dct::quant_matrices;
use crate::error::EncodeError;
use crate::format::{
    CHUNK_ICC, DEFAULT_MAX_PIXELS, HEADER_LEN, Header, MAX_DIM, MAX_METADATA, MAX_PALETTE,
    VERSION_ADAPTIVE, VERSION_CURRENT, VERSION_DEBLOCK, VERSION_MAX, VERSION_METADATA, VERSION_MIN,
    build_metadata_block, tile_grid,
};
use crate::parallel::par_map;
use crate::plane::{Plane, PlaneShape, RANGE_CHROMA_LOSSLESS, RANGE_LUMA, palette_range};
use crate::predict::med;
use crate::section::{write_dct_section, write_dct_section_v7, write_predictive_section};
use crate::tokens::{tokenize, zigzag};
use crate::{EncodeMode, ImageView, PixelFormat, lossless, lossy};
use std::collections::HashMap;

/// Порог качества, ниже которого включается сабсэмплинг цветоразностей 4:2:0.
const CHROMA420_MAX_QUALITY: u8 = 85;
/// v7.8 threshold rebalanced for scalar qmatrix and calibrated RDOQ.
const CHROMA420_MAX_QUALITY_V7: u8 = 85;
/// Порог качества, ниже которого включается деблокинг (битстрим v4):
/// при сильном квантовании блочность видна, фильтр её маскирует.
const DEBLOCK_MAX_QUALITY: u8 = 44;

pub fn encode(img: &ImageView<'_>, mode: EncodeMode) -> Result<Vec<u8>, EncodeError> {
    encode_impl(img, mode, base_version(mode), None)
}

/// Кодирует с вложением ICC-профиля. Lossy использует текущий v7, lossless —
/// минимальный v6, в котором появился блок метаданных.
pub fn encode_with_icc(
    img: &ImageView<'_>,
    mode: EncodeMode,
    icc: &[u8],
) -> Result<Vec<u8>, EncodeError> {
    if icc.is_empty() {
        return Err(EncodeError::InvalidIcc("пустой ICC-профиль"));
    }
    if icc.len() + 5 > MAX_METADATA {
        return Err(EncodeError::InvalidIcc("ICC-профиль больше 8 МиБ"));
    }
    encode_impl(
        img,
        mode,
        base_version(mode).max(VERSION_METADATA),
        Some(icc),
    )
}

/// Версию диктует набор инструментов: lossy пишет замороженный v7, lossless —
/// v3 (слой блоков не используется, файл не должен требовать более нового
/// декодера).
fn base_version(mode: EncodeMode) -> u8 {
    match mode {
        EncodeMode::Lossy { .. } => VERSION_ADAPTIVE,
        EncodeMode::Lossless => VERSION_CURRENT,
    }
}

/// Кодирует с явной версией битстрима (1..=7). Публичный кодер выбирает
/// версию сам (см. `encode`); явные версии — только для генерации
/// golden-векторов и тестов.
#[doc(hidden)]
pub fn encode_with_version(
    img: &ImageView<'_>,
    mode: EncodeMode,
    version: u8,
) -> Result<Vec<u8>, EncodeError> {
    encode_impl(img, mode, version, None)
}

fn encode_impl(
    img: &ImageView<'_>,
    mode: EncodeMode,
    version: u8,
    icc: Option<&[u8]>,
) -> Result<Vec<u8>, EncodeError> {
    if !(VERSION_MIN..=VERSION_MAX).contains(&version) {
        return Err(EncodeError::UnsupportedBitstreamVersion(version));
    }
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

    let meta_block = icc.map(|icc| build_metadata_block(&[(CHUNK_ICC, icc)]));
    let meta = meta_block.as_deref();

    match mode {
        EncodeMode::Lossless => {
            let planar = encode_lossless_planar(img, choose_identity(img, bpp), version, meta);
            Ok(match try_encode_palette(img, bpp, version, meta) {
                Some(palette) if palette.len() < planar.len() => palette,
                _ => planar,
            })
        }
        EncodeMode::Lossy { quality } => {
            if !(1..=100).contains(&quality) {
                return Err(EncodeError::InvalidQuality(quality));
            }
            let dct = encode_lossy(img, bpp, quality, version, meta);
            // Малоцветные изображения (графика, скриншоты): lossless-палитра
            // может быть одновременно меньше и точнее DCT — тогда она и уходит.
            Ok(match try_encode_palette(img, bpp, version, meta) {
                Some(palette) if palette.len() < dct.len() => palette,
                _ => dct,
            })
        }
    }
}

// --- сборка контейнера -------------------------------------------------------

fn assemble(
    header: &Header,
    meta_block: Option<&[u8]>,
    palette_block: Option<&[u8]>,
    payloads: &[Vec<u8>],
) -> Vec<u8> {
    let body_len: usize = payloads.iter().map(Vec::len).sum();
    let meta_len = meta_block.map_or(0, <[u8]>::len);
    let palette_len = palette_block.map_or(0, <[u8]>::len);
    let mut out =
        Vec::with_capacity(HEADER_LEN + meta_len + palette_len + payloads.len() * 4 + body_len);
    out.extend_from_slice(&header.serialize());
    if let Some(block) = meta_block {
        out.extend_from_slice(block);
    }
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

fn plane_payload(buf: &[i16], shape: PlaneShape, out: &mut Vec<u8>) {
    let mut syms = Vec::new();
    let mut raw = BitWriter::new();
    lossless::encode_tile_plane(buf, shape, &mut syms, &mut raw);
    write_predictive_section(out, lossless::N_CTX, &syms, raw, buf, shape);
}

// --- lossless: планарный (YCoCg-R либо identity RGB) --------------------------

fn encode_lossless_planar(
    img: &ImageView<'_>,
    identity: bool,
    version: u8,
    meta: Option<&[u8]>,
) -> Vec<u8> {
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
        version,
        width: img.width,
        height: img.height,
        lossless: true,
        alpha,
        chroma420: false,
        identity,
        palette: false,
        deblock: false,
        metadata: meta.is_some(),
        quality: 0,
    };
    let tiles = tile_grid(img.width, img.height);
    let payloads = par_map(&tiles, |t| {
        let mut payload = Vec::new();
        for (plane, range) in [(&p0, RANGE_LUMA), (&p1, chroma_range), (&p2, chroma_range)] {
            let buf = plane.extract(t.x0, t.y0, t.w, t.h);
            plane_payload(&buf, PlaneShape::new(t.w, t.h, range), &mut payload);
        }
        if let Some(pa) = pa.as_ref() {
            let buf = pa.extract(t.x0, t.y0, t.w, t.h);
            plane_payload(&buf, PlaneShape::new(t.w, t.h, RANGE_LUMA), &mut payload);
        }
        payload
    });
    assemble(&header, meta, None, &payloads)
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

fn try_encode_palette(
    img: &ImageView<'_>,
    bpp: usize,
    version: u8,
    meta: Option<&[u8]>,
) -> Option<Vec<u8>> {
    // Палитра — lossless-инструмент: v4-возможности (деблокинг) её не касаются,
    // заголовок не должен требовать более нового декодера, чем нужно.
    // Исключение — блок метаданных: он существует только с v6.
    let version = if meta.is_some() {
        version
    } else {
        version.min(VERSION_CURRENT)
    };
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
        version,
        width: img.width,
        height: img.height,
        lossless: true,
        alpha,
        chroma420: false,
        identity: false,
        palette: true,
        deblock: false,
        metadata: meta.is_some(),
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
    let payloads = par_map(&tiles, |t| {
        let mut payload = Vec::new();
        let buf = indices.extract(t.x0, t.y0, t.w, t.h);
        plane_payload(&buf, PlaneShape::new(t.w, t.h, range), &mut payload);
        payload
    });
    Some(assemble(&header, meta, Some(&block), &payloads))
}

// --- lossy: DCT ----------------------------------------------------------------

fn encode_lossy(
    img: &ImageView<'_>,
    bpp: usize,
    quality: u8,
    version: u8,
    meta: Option<&[u8]>,
) -> Vec<u8> {
    let (w, h) = (img.width as usize, img.height as usize);
    let alpha = bpp == 4;
    let header = Header {
        version,
        width: img.width,
        height: img.height,
        lossless: false,
        alpha,
        chroma420: quality
            <= if version >= VERSION_ADAPTIVE {
                CHROMA420_MAX_QUALITY_V7
            } else {
                CHROMA420_MAX_QUALITY
            },
        identity: false,
        palette: false,
        deblock: version >= VERSION_DEBLOCK && quality <= DEBLOCK_MAX_QUALITY,
        metadata: meta.is_some(),
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

    let (q_luma, q_chroma) = quant_matrices(version, quality);

    let tiles = tile_grid(img.width, img.height);
    let payloads = par_map(&tiles, |t| {
        let mut payload = Vec::new();
        // v7: банк адаптивных моделей общий для всех плоскостей тайла.
        let mut bank = (version >= VERSION_ADAPTIVE).then(|| {
            let (groups, kinds) = lossy::ctx_meta_v7();
            crate::arith::ModelBank::new(groups, kinds)
        });
        let buf = p0.extract(t.x0, t.y0, t.w, t.h);
        let luma_recon = dct_payload(
            &buf,
            None,
            (t.w, t.h),
            &q_luma,
            DctConfig {
                version,
                deblock: header.deblock,
                cdef: true,
            },
            bank.as_mut(),
            &mut payload,
        );
        // A/B Kodak: текущая CfL-модель выигрывает только при 4:2:0;
        // decoder всё равно принимает CfL и для 4:4:4 как свободу кодера.
        let cfl_luma = luma_recon
            .filter(|_| header.chroma420)
            .map(|recon| downsample_420(&recon, t.w, t.h));
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
            dct_payload(
                &cbuf,
                cfl_luma.as_deref(),
                (cw, ch),
                &q_chroma,
                DctConfig {
                    version,
                    deblock: header.deblock,
                    cdef: true,
                },
                bank.as_mut(),
                &mut payload,
            );
        }
        if let Some(pa) = pa.as_ref() {
            let buf = pa.extract(t.x0, t.y0, t.w, t.h);
            plane_payload(&buf, PlaneShape::new(t.w, t.h, RANGE_LUMA), &mut payload);
        }
        payload
    });
    assemble(&header, meta, None, &payloads)
}

#[derive(Clone, Copy)]
struct DctConfig {
    version: u8,
    deblock: bool,
    cdef: bool,
}

fn dct_payload(
    buf: &[i16],
    cfl_luma: Option<&[i16]>,
    size: (usize, usize),
    qmat: &[u16; 64],
    config: DctConfig,
    bank: Option<&mut crate::arith::ModelBank>,
    out: &mut Vec<u8>,
) -> Option<Vec<i16>> {
    let (w, h) = size;
    let mut syms = Vec::new();
    let mut raw = BitWriter::new();
    if config.version >= VERSION_ADAPTIVE {
        let recon = lossy::encode_tile_plane_v7(buf, cfl_luma, w, h, qmat, &mut syms, &mut raw);
        let strength = if config.cdef {
            crate::cdef::choose_strength(buf, &recon, w, h, qmat[0], config.deblock)
        } else {
            0
        };
        syms.insert(0, (lossy::CTX7_CDEF, strength));
        write_dct_section_v7(out, bank.expect("v7: банк обязателен"), &syms, raw);
        return Some(recon);
    }
    match config.version {
        1 => lossy::encode_tile_plane_v1(buf, w, h, qmat, &mut syms, &mut raw),
        2 => lossy::encode_tile_plane_v2(buf, w, h, qmat, &mut syms, &mut raw),
        3 | 4 => lossy::encode_tile_plane(buf, w, h, qmat, &mut syms, &mut raw),
        _ => lossy::encode_tile_plane_v5(buf, w, h, qmat, &mut syms, &mut raw),
    }
    let n_ctx = match config.version {
        1 => lossy::N_CTX_V1,
        2 => lossy::N_CTX_V2,
        3 | 4 => lossy::N_CTX_V3,
        _ => lossy::N_CTX_V5,
    };
    write_dct_section(out, n_ctx, &syms, raw);
    None
}
