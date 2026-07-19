//! Декодер изображения. Контракт: любые входные байты → `Ok` или `Err`,
//! никаких паник; память аллоцируется только после проверки лимитов.
//!
//! Ход работы: последовательный разбор контейнера (заголовок, палитра,
//! таблица тайлов, нарезка payload'ов), затем независимое — при наличии
//! `threads` параллельное — декодирование тайлов, затем сборка плоскостей
//! в порядке тайлов. Результат не зависит от числа потоков.

use crate::arith::{ModelBank, RangeDecoder};
use crate::bits::BitReader;
use crate::color::{
    downsample_420, upsample_420, upsample_420_centered, ycbcr_to_rgb, ycocg_lossy_to_rgb,
    ycocg_r_to_rgb,
};
use crate::dct::{quant_matrices, quant_matrices_v8};
use crate::error::DecodeError;
use crate::format::{HEADER_LEN, Header, Metadata, TileRect, parse_metadata_block, tile_grid};
use crate::format::{VERSION_ADAPTIVE, VERSION_RECT};
use crate::parallel::par_map;
use crate::plane::{Plane, PlaneShape, RANGE_CHROMA_LOSSLESS, RANGE_LUMA, palette_range};
use crate::rans::RansDecoder;
use crate::section::{
    PredictiveSection, read_dct_section, read_dct_section_v7, read_predictive_section, unpack_raw,
};
use crate::{DecodeLimits, DecodedImage, PixelFormat, lossless, lossy};

/// Результат декодирования одного тайла: цветовые плоскости (1 либо 3) + альфа.
struct TileBufs {
    color: Vec<Vec<i16>>,
    alpha: Option<Vec<i16>>,
}

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

    // Опциональный блок метаданных сразу после заголовка (v6+).
    let mut offset = HEADER_LEN;
    let meta = if header.metadata {
        let (meta, used) = parse_metadata_block(bytes, offset)?;
        offset += used;
        meta
    } else {
        Metadata::default()
    };

    // Опциональный блок палитры (после метаданных, если они есть).
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

    // Нарезка payload'ов по таблице длин — последовательно и до аллокаций плоскостей.
    let mut jobs: Vec<(TileRect, &[u8])> = Vec::with_capacity(tiles.len());
    for (i, t) in tiles.iter().enumerate() {
        let len = u32::from_le_bytes(table[i * 4..i * 4 + 4].try_into().expect("len 4")) as usize;
        let end = offset
            .checked_add(len)
            .ok_or(DecodeError::Corrupt("переполнение смещения"))?;
        let Some(payload) = bytes.get(offset..end) else {
            return Err(DecodeError::Corrupt("обрыв данных тайла"));
        };
        offset = end;
        jobs.push((*t, payload));
    }
    if offset != bytes.len() {
        return Err(DecodeError::Corrupt("лишние байты после последнего тайла"));
    }

    // Матрицы плоскостей: v8 — пошаговые Y/Co/Cg, до v8 — luma/chroma/chroma.
    let q_planes: [[u16; 64]; 3] = if header.version >= VERSION_RECT {
        let (qy, qco, qcg) = quant_matrices_v8(header.quality.max(1));
        [qy, qco, qcg]
    } else {
        let (q_luma, q_chroma) = quant_matrices(header.version, header.quality.max(1));
        [q_luma, q_chroma, q_chroma]
    };
    let chroma_range = if header.identity {
        RANGE_LUMA
    } else {
        RANGE_CHROMA_LOSSLESS
    };
    let palette_len = palette.as_ref().map(Vec::len);

    // Независимое декодирование тайлов.
    let decoded: Vec<Result<TileBufs, DecodeError>> = par_map(&jobs, |&(t, payload)| {
        decode_tile(payload, t, &header, palette_len, chroma_range, &q_planes)
    });

    // Сборка плоскостей в порядке тайлов.
    let n_color_planes = if palette.is_some() { 1 } else { 3 };
    let mut planes: Vec<Plane> = (0..n_color_planes).map(|_| Plane::new(w, h)).collect();
    let mut pa = (header.alpha && palette.is_none()).then(|| Plane::new(w, h));
    for (result, (t, _)) in decoded.into_iter().zip(jobs.iter()) {
        let bufs = result?;
        for (plane, buf) in planes.iter_mut().zip(bufs.color.iter()) {
            plane.insert(t.x0, t.y0, t.w, t.h, buf);
        }
        if let (Some(pa), Some(buf)) = (pa.as_mut(), bufs.alpha.as_ref()) {
            pa.insert(t.x0, t.y0, t.w, t.h, buf);
        }
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
            } else if header.version >= VERSION_RECT {
                ycocg_lossy_to_rgb(c0, c1, c2)
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
        icc: meta.icc,
    })
}

/// Читает ICC-профиль из потока без декодирования пикселей:
/// разбирается только заголовок и блок метаданных.
pub fn read_icc(bytes: &[u8]) -> Result<Option<Vec<u8>>, DecodeError> {
    let header = Header::parse(bytes)?;
    if !header.metadata {
        return Ok(None);
    }
    let (meta, _) = parse_metadata_block(bytes, HEADER_LEN)?;
    Ok(meta.icc)
}

/// Декодирует все секции одного тайла; валидирует точное потребление payload.
fn decode_tile(
    payload: &[u8],
    t: TileRect,
    header: &Header,
    palette_len: Option<usize>,
    chroma_range: crate::plane::SampleRange,
    q_planes: &[[u16; 64]; 3],
) -> Result<TileBufs, DecodeError> {
    let version = header.version;
    let mut pos = 0usize;
    let mut color = Vec::with_capacity(if palette_len.is_some() { 1 } else { 3 });
    if let Some(len) = palette_len {
        let range = palette_range(len);
        color.push(read_lossless_plane(
            payload,
            &mut pos,
            PlaneShape::new(t.w, t.h, range),
        )?);
    } else if header.lossless {
        for range in [RANGE_LUMA, chroma_range, chroma_range] {
            color.push(read_lossless_plane(
                payload,
                &mut pos,
                PlaneShape::new(t.w, t.h, range),
            )?);
        }
    } else {
        // v7/v8: банк адаптивных моделей общий для всех плоскостей тайла.
        let mut bank = match version {
            v if v >= VERSION_RECT => {
                let (groups, kinds) = lossy::ctx_meta_v8();
                Some(ModelBank::new(groups, kinds))
            }
            v if v >= VERSION_ADAPTIVE => {
                let (groups, kinds) = lossy::ctx_meta_v7();
                Some(ModelBank::new(groups, kinds))
            }
            _ => None,
        };
        let luma_plane = read_dct_plane(
            payload,
            &mut pos,
            (t.w, t.h),
            None,
            &q_planes[0],
            version,
            bank.as_mut(),
        )?;
        let mut luma = luma_plane.buf;
        let cfl_luma = (version >= VERSION_ADAPTIVE).then(|| {
            if header.chroma420 {
                downsample_420(&luma, t.w, t.h)
            } else {
                luma.clone()
            }
        });
        if header.deblock {
            crate::deblock::deblock_plane(&mut luma, t.w, t.h, q_planes[0][0]);
        }
        crate::cdef::filter_plane(&mut luma, t.w, t.h, luma_plane.cdef_strength);
        color.push(luma);
        for qmat in [&q_planes[1], &q_planes[2]] {
            let (cw, ch) = if header.chroma420 {
                (t.w.div_ceil(2), t.h.div_ceil(2))
            } else {
                (t.w, t.h)
            };
            let chroma_plane = read_dct_plane(
                payload,
                &mut pos,
                (cw, ch),
                cfl_luma.as_deref(),
                qmat,
                version,
                bank.as_mut(),
            )?;
            let mut cbuf = chroma_plane.buf;
            if header.deblock {
                // Хрома фильтруется в собственном разрешении, до апсэмплинга.
                crate::deblock::deblock_plane(&mut cbuf, cw, ch, qmat[0]);
            }
            crate::cdef::filter_plane(&mut cbuf, cw, ch, chroma_plane.cdef_strength);
            let full = if header.chroma420 {
                // v1–v6 сохраняют исторический co-sited upsampler; v7.6
                // согласует фазу с center-sited средним downsample 2×2.
                if version >= VERSION_ADAPTIVE {
                    upsample_420_centered(&cbuf, cw, ch, t.w, t.h)
                } else {
                    upsample_420(&cbuf, cw, ch, t.w, t.h)
                }
            } else {
                cbuf
            };
            color.push(full);
        }
    }
    let alpha = if header.alpha && palette_len.is_none() {
        Some(read_lossless_plane(
            payload,
            &mut pos,
            PlaneShape::new(t.w, t.h, RANGE_LUMA),
        )?)
    } else {
        None
    };
    if pos != payload.len() {
        return Err(DecodeError::Corrupt("лишние байты в тайле"));
    }
    Ok(TileBufs { color, alpha })
}

/// Читает предиктивную секцию (coded либо raw), валидируя завершение потоков.
fn read_lossless_plane(
    payload: &[u8],
    pos: &mut usize,
    shape: PlaneShape,
) -> Result<Vec<i16>, DecodeError> {
    let (section, used) = read_predictive_section(&payload[*pos..], lossless::N_CTX, shape)?;
    *pos += used;
    match section {
        PredictiveSection::Raw(packed) => unpack_raw(packed, shape),
        PredictiveSection::Coded(section) => {
            let mut dec = RansDecoder::new(section.tokens)?;
            let mut raw = BitReader::new(section.raw);
            let buf = lossless::decode_tile_plane(&section, &mut dec, &mut raw, shape)?;
            dec.finish()?;
            if raw.unread_bytes() != 0 {
                return Err(DecodeError::Corrupt("лишние байты в потоке сырых бит"));
            }
            Ok(buf)
        }
    }
}

struct DctPlane {
    buf: Vec<i16>,
    cdef_strength: u8,
}

/// Читает одну DCT-секцию, полностью валидируя завершение потоков.
fn read_dct_plane(
    payload: &[u8],
    pos: &mut usize,
    size: (usize, usize),
    cfl_luma: Option<&[i16]>,
    qmat: &[u16; 64],
    version: u8,
    bank: Option<&mut ModelBank>,
) -> Result<DctPlane, DecodeError> {
    let (w, h) = size;
    if version >= VERSION_ADAPTIVE {
        // Контейнер секции v7 и v8 одинаков; различаются дерево и контексты.
        let (section, used) = read_dct_section_v7(&payload[*pos..])?;
        *pos += used;
        let bank = bank.expect("v7/v8: банк обязателен");
        let mut dec = RangeDecoder::new(section.tokens)?;
        let mut raw = BitReader::new(section.raw);
        let cdef_ctx = if version >= VERSION_RECT {
            usize::from(lossy::CTX8_CDEF)
        } else {
            usize::from(lossy::CTX7_CDEF)
        };
        let cdef_strength = bank.decode(&mut dec, cdef_ctx)?;
        if cdef_strength >= crate::cdef::N_STRENGTHS {
            return Err(DecodeError::Corrupt("CDEF: неизвестная сила"));
        }
        let buf = if version >= VERSION_RECT {
            lossy::decode_tile_plane_v8(bank, &mut dec, &mut raw, w, h, cfl_luma, qmat)?
        } else {
            lossy::decode_tile_plane_v7(bank, &mut dec, &mut raw, w, h, cfl_luma, qmat)?
        };
        if dec.consumed() != section.tokens.len() {
            return Err(DecodeError::Corrupt("лишние байты в адаптивном потоке"));
        }
        if raw.unread_bytes() != 0 {
            return Err(DecodeError::Corrupt("лишние байты в потоке сырых бит"));
        }
        return Ok(DctPlane { buf, cdef_strength });
    }
    let n_ctx = match version {
        5.. => lossy::N_CTX_V5,
        3 | 4 => lossy::N_CTX_V3,
        2 => lossy::N_CTX_V2,
        _ => lossy::N_CTX_V1,
    };
    let (section, used) = read_dct_section(&payload[*pos..], n_ctx)?;
    *pos += used;
    let mut dec = RansDecoder::new(section.tokens)?;
    let mut raw = BitReader::new(section.raw);
    let buf = match version {
        5 | 6 => lossy::decode_tile_plane_v5(&section, &mut dec, &mut raw, w, h, qmat)?,
        3 | 4 => lossy::decode_tile_plane(&section, &mut dec, &mut raw, w, h, qmat)?,
        2 => lossy::decode_tile_plane_v2(&section, &mut dec, &mut raw, w, h, qmat)?,
        _ => lossy::decode_tile_plane_v1(&section, &mut dec, &mut raw, w, h, qmat)?,
    };
    dec.finish()?;
    if raw.unread_bytes() != 0 {
        return Err(DecodeError::Corrupt("лишние байты в потоке сырых бит"));
    }
    Ok(DctPlane {
        buf,
        cdef_strength: 0,
    })
}
