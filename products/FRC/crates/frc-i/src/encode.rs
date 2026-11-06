//! Кодер изображения: план тайлов и плоскостей общий с декодером (frc-i.md §2.4).
//!
//! Выбор инструментов внутри lossless — за кодером (палитра, identity vs
//! YCoCg-R, raw-fallback секций): декодер читает любой корректный поток,
//! поэтому эвристики можно улучшать без изменения формата.

use crate::bits::BitWriter;
use crate::color::{downsample_420, rgb_to_ycbcr, rgb_to_ycocg_lossy, rgb_to_ycocg_r};
use crate::dct::{quant_matrices, quant_matrices_v8, quant_matrices_v9};
use crate::error::EncodeError;
use crate::format::{
    CHUNK_ICC, DEFAULT_MAX_PIXELS, HEADER_LEN, Header, MAX_DIM, MAX_METADATA, MAX_PALETTE,
    VERSION_ADAPTIVE, VERSION_CURRENT, VERSION_DEBLOCK, VERSION_FREQ_SHAPE, VERSION_HIER_AQ,
    VERSION_MAX, VERSION_METADATA, VERSION_MIN, VERSION_PERCEPTUAL, VERSION_RECT,
    build_metadata_block, tile_grid,
};
use crate::parallel::par_map;
use crate::plane::{Plane, PlaneShape, RANGE_CHROMA_LOSSLESS, RANGE_LUMA, palette_range};
use crate::predict::med;
use crate::section::{write_dct_section, write_dct_section_v7, write_predictive_section};
use crate::tokens::{tokenize, zigzag};
use crate::tuning;
use crate::{EncodeMode, ImageView, PixelFormat, lossless, lossy};
use std::collections::HashMap;

// Настройки A/B (AQ/RD/TS/порогов) живут в `tuning.rs`: без feature
// `tuning-env` они компилируются в замороженные константы.

pub fn encode(img: &ImageView<'_>, mode: EncodeMode) -> Result<Vec<u8>, EncodeError> {
    encode_impl(img, mode, base_version(mode), None, None)
}

/// Кодирует с вложением ICC-профиля. Lossy использует текущий публичный v14,
/// lossless — минимальный v6, в котором появился блок метаданных.
pub fn encode_with_icc(
    img: &ImageView<'_>,
    mode: EncodeMode,
    icc: &[u8],
) -> Result<Vec<u8>, EncodeError> {
    encode_with_icc_version(img, mode, icc, base_version(mode).max(VERSION_METADATA))
}

/// Версию диктует набор инструментов: публичный lossy-кодер пишет v14
/// (частотная форма, кадровое решение `ts`). Lossless пишет v3.
fn base_version(mode: EncodeMode) -> u8 {
    match mode {
        EncodeMode::Lossy { .. } => VERSION_FREQ_SHAPE,
        EncodeMode::Lossless => VERSION_CURRENT,
    }
}

/// Кодирует с явной версией битстрима (1..=14). Публичный кодер выбирает
/// версию сам (см. `encode`); явные версии — только для генерации
/// golden-векторов и тестов.
#[doc(hidden)]
pub fn encode_with_version(
    img: &ImageView<'_>,
    mode: EncodeMode,
    version: u8,
) -> Result<Vec<u8>, EncodeError> {
    encode_impl(img, mode, version, None, None)
}

/// Тестовый хук: v14 с принудительным паттерном `ts` по корням luma
/// (паттерн применяется циклично; пустой — все нули). Публичный API не
/// использует; нужен дифференциальным тестам §3.3.
#[doc(hidden)]
pub fn encode_with_version_ts(
    img: &ImageView<'_>,
    mode: EncodeMode,
    version: u8,
    ts_pattern: &[u8],
) -> Result<Vec<u8>, EncodeError> {
    encode_impl(img, mode, version, None, Some(ts_pattern))
}

/// Кодирует с ICC-профилем и явной версией битстрима: заморозка v7..v14 golden
/// (`encode_with_icc` пишет текущий публичный v14).
#[doc(hidden)]
pub fn encode_with_icc_version(
    img: &ImageView<'_>,
    mode: EncodeMode,
    icc: &[u8],
    version: u8,
) -> Result<Vec<u8>, EncodeError> {
    if icc.is_empty() {
        return Err(EncodeError::InvalidIcc("пустой ICC-профиль"));
    }
    if icc.len() + 5 > MAX_METADATA {
        return Err(EncodeError::InvalidIcc("ICC-профиль больше 8 МиБ"));
    }
    encode_impl(img, mode, version.max(VERSION_METADATA), Some(icc), None)
}

fn encode_impl(
    img: &ImageView<'_>,
    mode: EncodeMode,
    version: u8,
    icc: Option<&[u8]>,
    ts_force: Option<&[u8]>,
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
            // Малоцветные изображения (графика, скриншоты): lossless-палитра
            // может быть одновременно меньше и точнее DCT — тогда она и уходит.
            let Some(palette) = try_encode_palette(img, bpp, version, meta) else {
                return Ok(encode_lossy(img, bpp, quality, version, meta, ts_force));
            };
            // Порог палитры v14 считается по нейтральному DCT (все `ts = 0`,
            // размер линии v13): наклон частотной формы экономит биты DCT и
            // иначе сдвигал бы границу «lossless-графика → lossy» (§11.12,
            // критерий 12). Двойной DCT-проход — только у палитровых кадров
            // (≤ 256 цветов), фото выходят из подсчёта палитры раньше.
            let neutral_force: &[u8] = &[0];
            let gate_dct = if version >= VERSION_FREQ_SHAPE {
                encode_lossy(img, bpp, quality, version, meta, Some(neutral_force))
            } else {
                encode_lossy(img, bpp, quality, version, meta, ts_force)
            };
            if palette.len() < gate_dct.len() {
                return Ok(palette);
            }
            if version >= VERSION_FREQ_SHAPE && ts_force != Some(neutral_force) {
                return Ok(encode_lossy(img, bpp, quality, version, meta, ts_force));
            }
            Ok(gate_dct)
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
    ts_force: Option<&[u8]>,
) -> Vec<u8> {
    let (w, h) = (img.width as usize, img.height as usize);
    let alpha = bpp == 4;
    let header = Header {
        version,
        width: img.width,
        height: img.height,
        lossless: false,
        alpha,
        chroma420: quality <= tuning::chroma420_qmax(version),
        identity: false,
        palette: false,
        deblock: quality < tuning::deblock_qmax(version) && version >= VERSION_DEBLOCK,
        metadata: meta.is_some(),
        quality,
    };

    // v8: целочисленный lossy-YCoCg (§7.9b), иначе BT.601 YCbCr (§6.2).
    let mut p0 = Plane::new(w, h);
    let mut p1 = Plane::new(w, h);
    let mut p2 = Plane::new(w, h);
    let mut pa = alpha.then(|| Plane::new(w, h));
    for i in 0..w * h {
        let px = &img.data[i * bpp..i * bpp + bpp];
        let rgb = (i32::from(px[0]), i32::from(px[1]), i32::from(px[2]));
        let (c0, c1, c2) = if version >= VERSION_RECT {
            rgb_to_ycocg_lossy(rgb.0, rgb.1, rgb.2)
        } else {
            rgb_to_ycbcr(rgb.0, rgb.1, rgb.2)
        };
        p0.data[i] = c0 as i16;
        p1.data[i] = c1 as i16;
        p2.data[i] = c2 as i16;
        if let Some(pa) = pa.as_mut() {
            pa.data[i] = i16::from(px[3]);
        }
    }

    // Матрицы плоскостей: v8+ — пошаговые Y/Co/Cg, до v8 — luma/chroma/chroma.
    let q_planes: [[u16; 64]; 3] = if version >= VERSION_PERCEPTUAL {
        let (qy, qco, qcg) = quant_matrices_v9(quality);
        [qy, qco, qcg]
    } else if version >= VERSION_RECT {
        let (qy, qco, qcg) = quant_matrices_v8(quality);
        [qy, qco, qcg]
    } else {
        let (q_luma, q_chroma) = quant_matrices(version, quality);
        [q_luma, q_chroma, q_chroma]
    };
    let (dq_luma, dq_chroma) = tuning::dq_tunings(version);
    let rd = tuning::rd_tuning(version);
    let ts_luma = tuning::ts_tuning(version, true);
    let ts_chroma = tuning::ts_tuning(version, false);
    // Режимы 7–9 принимают решение по всему кадру, иначе каждый тайл 256×256
    // независимо включает tilt и на швах появляются BA-хотспоты.
    let frame_ts = if ts_force.is_none() {
        lossy::frame_ts_pattern(&p0.data, w, h, &q_planes[0], dq_luma, ts_luma, quality)
    } else {
        None
    };
    let luma_ts = ts_force.or(frame_ts.as_deref());

    let tiles = tile_grid(img.width, img.height);
    let payloads = par_map(&tiles, |t| {
        let mut payload = Vec::new();
        // v7+: банк адаптивных моделей общий для всех плоскостей тайла.
        // Раскладка v8 совпадает с v7 (отличие v8 — цвет/qmat); v9+ добавляет
        // DQ, v11 — DQR (refinement детей 16×16), v14 — TS (частотная форма).
        let mut bank = if version >= VERSION_FREQ_SHAPE {
            let (groups, kinds) = lossy::ctx_meta_v14();
            Some(crate::arith::ModelBank::new(groups, kinds))
        } else if version >= VERSION_HIER_AQ {
            let (groups, kinds) = lossy::ctx_meta_v11();
            Some(crate::arith::ModelBank::new(groups, kinds))
        } else if version >= VERSION_PERCEPTUAL {
            let (groups, kinds) = lossy::ctx_meta_v9();
            Some(crate::arith::ModelBank::new(groups, kinds))
        } else if version >= VERSION_ADAPTIVE {
            let (groups, kinds) = lossy::ctx_meta_v7();
            Some(crate::arith::ModelBank::new(groups, kinds))
        } else {
            None
        };
        let buf = p0.extract(t.x0, t.y0, t.w, t.h);
        let luma_recon = dct_payload(
            &buf,
            None,
            (t.w, t.h),
            &q_planes[0],
            DctConfig {
                version,
                deblock: header.deblock,
                cdef: true,
                dq: dq_luma,
                ts: ts_luma,
                quality,
                rd,
            },
            bank.as_mut(),
            luma_ts,
            &mut payload,
        );
        // A/B Kodak: текущая CfL-модель выигрывает только при 4:2:0;
        // decoder всё равно принимает CfL и для 4:4:4 как свободу кодера.
        let cfl_luma = luma_recon
            .filter(|_| header.chroma420)
            .map(|recon| downsample_420(&recon, t.w, t.h));
        for (plane, qmat) in [(&p1, &q_planes[1]), (&p2, &q_planes[2])] {
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
                qmat,
                DctConfig {
                    version,
                    deblock: header.deblock,
                    cdef: true,
                    dq: dq_chroma,
                    ts: ts_chroma,
                    quality,
                    rd,
                },
                bank.as_mut(),
                None,
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
    /// Настройки адаптивной квантизации v9/v10 (игнорируются до v9).
    dq: lossy::DqTuning,
    /// Эвристика частотной формы v14 (игнорируется до v14).
    ts: lossy::TsTuning,
    /// Качество изображения — вход эвристики `ts`.
    quality: u8,
    /// RD-калибровка блочного слоя v11/v12/v13/v14 (игнорируется до v11:
    /// замороженные v7–v10 держат `RdTuning::LEGACY` внутри).
    rd: lossy::RdTuning,
}

#[allow(clippy::too_many_arguments)]
fn dct_payload(
    buf: &[i16],
    cfl_luma: Option<&[i16]>,
    size: (usize, usize),
    qmat: &[u16; 64],
    config: DctConfig,
    bank: Option<&mut crate::arith::ModelBank>,
    ts_force: Option<&[u8]>,
    out: &mut Vec<u8>,
) -> Option<Vec<i16>> {
    let (w, h) = size;
    let mut syms = Vec::new();
    let mut raw = BitWriter::new();
    if config.version >= VERSION_ADAPTIVE {
        // v7..v13 делят дерево и энтропию; v8 меняет цвет/qmat, v9+
        // добавляет per-root delta-Q, v11 — refinement детей 16×16,
        // v12 — перцептивную RD-калибровку кодера, v13 — rate-aware
        // докалибровку оставшихся констант PSNR-эпохи (wire v11).
        let recon = if config.version >= VERSION_FREQ_SHAPE {
            lossy::encode_tile_plane_v14(
                buf,
                cfl_luma,
                w,
                h,
                qmat,
                config.dq,
                config.ts,
                config.quality,
                ts_force,
                config.rd,
                &mut syms,
                &mut raw,
            )
        } else if config.version >= VERSION_HIER_AQ {
            lossy::encode_tile_plane_v11(
                buf, cfl_luma, w, h, qmat, config.dq, config.rd, &mut syms, &mut raw,
            )
        } else if config.version >= VERSION_PERCEPTUAL {
            lossy::encode_tile_plane_v9(buf, cfl_luma, w, h, qmat, config.dq, &mut syms, &mut raw)
        } else {
            lossy::encode_tile_plane_v7(buf, cfl_luma, w, h, qmat, &mut syms, &mut raw)
        };
        let strength = if config.cdef {
            crate::cdef::choose_strength(buf, &recon, w, h, qmat[0], config.deblock)
        } else {
            0
        };
        syms.insert(0, (lossy::CTX7_CDEF, strength));
        write_dct_section_v7(out, bank.expect("v7+: банк обязателен"), &syms, raw);
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
