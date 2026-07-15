//! Секции плоскостей внутри тайла (FIC.md §4).
//!
//! Предиктивная (lossless) секция начинается с байта режима:
//!
//! ```text
//! mode 0 (coded): [0][freq-table x n_ctx][token_len u32][raw_len u32][tokens][raw bits]
//! mode 1 (raw):   [1][отсчёты, упакованные по range.raw_bits() бит, row-major]
//! ```
//!
//! Режим 1 — гарантия худшего случая: несжимаемая плоскость никогда не
//! занимает больше `ceil(w*h*bits/8) + 1` байт. Кодер всегда выбирает меньшее.
//!
//! DCT-секция байта режима не имеет (полезной сырой формы у неё нет):
//!
//! ```text
//! [freq-table x n_ctx][token_len u32][raw_len u32][tokens][raw bits]
//! ```
//!
//! Число контекстов `n_ctx` фиксировано версией формата и видом секции —
//! оно не сериализуется.

use crate::bits::{BitReader, BitWriter};
use crate::error::DecodeError;
use crate::plane::PlaneShape;
use crate::rans::{FreqTable, encode_symbols};
use crate::tokens::ALPHABET;

const MODE_CODED: u8 = 0;
const MODE_RAW: u8 = 1;

/// Число байт сырой формы плоскости.
pub fn raw_payload_len(shape: PlaneShape) -> usize {
    (shape.samples() * shape.range.raw_bits() as usize).div_ceil(8)
}

/// Собирает энтропийную часть секции (таблицы + потоки) без байта режима.
fn build_coded(n_ctx: usize, syms: &[(u8, u8)], raw: BitWriter) -> Vec<u8> {
    let mut hists = vec![[0u32; ALPHABET]; n_ctx];
    for &(ctx, sym) in syms {
        hists[usize::from(ctx)][usize::from(sym)] += 1;
    }
    let tables: Vec<FreqTable> = hists.iter().map(FreqTable::from_histogram).collect();
    let mut out = Vec::new();
    for table in &tables {
        table.serialize(&mut out);
    }
    let tokens = encode_symbols(&tables, syms);
    let raw_bytes = raw.finish();
    out.extend_from_slice(&(tokens.len() as u32).to_le_bytes());
    out.extend_from_slice(&(raw_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&tokens);
    out.extend_from_slice(&raw_bytes);
    out
}

/// Дописывает DCT-секцию (всегда coded).
pub fn write_dct_section(out: &mut Vec<u8>, n_ctx: usize, syms: &[(u8, u8)], raw: BitWriter) {
    out.extend_from_slice(&build_coded(n_ctx, syms, raw));
}

/// Дописывает предиктивную секцию, выбирая меньшую из coded/raw форм.
pub fn write_predictive_section(
    out: &mut Vec<u8>,
    n_ctx: usize,
    syms: &[(u8, u8)],
    raw: BitWriter,
    samples: &[i16],
    shape: PlaneShape,
) {
    debug_assert_eq!(samples.len(), shape.samples());
    let coded = build_coded(n_ctx, syms, raw);
    if coded.len() <= raw_payload_len(shape) {
        out.push(MODE_CODED);
        out.extend_from_slice(&coded);
    } else {
        out.push(MODE_RAW);
        let bits = shape.range.raw_bits();
        let mut packer = BitWriter::new();
        for &s in samples {
            packer.write((i32::from(s) - shape.range.lo) as u32, bits);
        }
        out.extend_from_slice(&packer.finish());
    }
}

/// Распарсенная coded-секция: таблицы и срезы потоков.
pub struct Section<'a> {
    pub tables: Vec<FreqTable>,
    pub tokens: &'a [u8],
    pub raw: &'a [u8],
}

/// Результат чтения предиктивной секции.
pub enum PredictiveSection<'a> {
    Coded(Section<'a>),
    /// Срез упакованных сырых отсчётов (длина уже проверена).
    Raw(&'a [u8]),
}

/// Читает coded-секцию с начала `bytes`; возвращает секцию и число съеденных байт.
pub fn read_dct_section(bytes: &[u8], n_ctx: usize) -> Result<(Section<'_>, usize), DecodeError> {
    read_coded(bytes, n_ctx)
}

/// Читает предиктивную секцию (mode-байт, затем coded- или raw-форма).
pub fn read_predictive_section(
    bytes: &[u8],
    n_ctx: usize,
    shape: PlaneShape,
) -> Result<(PredictiveSection<'_>, usize), DecodeError> {
    let Some((&mode, rest)) = bytes.split_first() else {
        return Err(DecodeError::Corrupt("section: обрыв байта режима"));
    };
    match mode {
        MODE_CODED => {
            let (section, used) = read_coded(rest, n_ctx)?;
            Ok((PredictiveSection::Coded(section), used + 1))
        }
        MODE_RAW => {
            let len = raw_payload_len(shape);
            let Some(payload) = rest.get(..len) else {
                return Err(DecodeError::Corrupt("section: обрыв raw-отсчётов"));
            };
            Ok((PredictiveSection::Raw(payload), len + 1))
        }
        _ => Err(DecodeError::Corrupt("section: неизвестный режим")),
    }
}

/// Распаковывает raw-форму плоскости с клампом в диапазон.
pub fn unpack_raw(payload: &[u8], shape: PlaneShape) -> Result<Vec<i16>, DecodeError> {
    let bits = shape.range.raw_bits();
    let mut reader = BitReader::new(payload);
    let mut out = Vec::with_capacity(shape.samples());
    for _ in 0..shape.samples() {
        let v = reader.read(bits)? as i32 + shape.range.lo;
        out.push(v.clamp(shape.range.lo, shape.range.hi) as i16);
    }
    Ok(out)
}

fn read_coded(bytes: &[u8], n_ctx: usize) -> Result<(Section<'_>, usize), DecodeError> {
    let mut pos = 0usize;
    let mut tables = Vec::with_capacity(n_ctx);
    for _ in 0..n_ctx {
        let (table, used) = FreqTable::deserialize(&bytes[pos..])?;
        pos += used;
        tables.push(table);
    }
    // Арифметика позиций — checked: длины приходят из недоверенного потока,
    // а на 32-битных целях (wasm) сложение usize может переполниться.
    let lens_end = pos.checked_add(8).ok_or(DecodeError::Corrupt("section: переполнение"))?;
    let Some(lens) = bytes.get(pos..lens_end) else {
        return Err(DecodeError::Corrupt("section: обрыв длин потоков"));
    };
    let token_len = u32::from_le_bytes(lens[0..4].try_into().expect("len 4")) as usize;
    let raw_len = u32::from_le_bytes(lens[4..8].try_into().expect("len 4")) as usize;
    pos = lens_end;
    let tok_end =
        pos.checked_add(token_len).ok_or(DecodeError::Corrupt("section: переполнение"))?;
    let Some(tokens) = bytes.get(pos..tok_end) else {
        return Err(DecodeError::Corrupt("section: обрыв потока токенов"));
    };
    pos = tok_end;
    let raw_end = pos.checked_add(raw_len).ok_or(DecodeError::Corrupt("section: переполнение"))?;
    let Some(raw) = bytes.get(pos..raw_end) else {
        return Err(DecodeError::Corrupt("section: обрыв потока сырых бит"));
    };
    pos = raw_end;
    Ok((Section { tables, tokens, raw }, pos))
}
