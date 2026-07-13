//! Секция плоскости внутри тайла (FIC.md §5.6): таблицы частот всех контекстов,
//! затем два потока — rANS-токены и сырые биты.
//!
//! ```text
//! [freq-table x n_ctx][token_len: u32 LE][raw_len: u32 LE][token bytes][raw bytes]
//! ```
//! Число контекстов не сериализуется — оно однозначно определяется режимом
//! плоскости (lossless: 8, DCT: 5) из заголовка файла.

use crate::bits::BitWriter;
use crate::error::DecodeError;
use crate::rans::{encode_symbols, FreqTable};
use crate::tokens::ALPHABET;

/// Собирает секцию плоскости: строит таблицы по фактическим гистограммам,
/// кодирует токены rANS и дописывает секцию в `out`.
pub fn write_section(out: &mut Vec<u8>, n_ctx: usize, syms: &[(u8, u8)], raw: BitWriter) {
    let mut hists = vec![[0u32; ALPHABET]; n_ctx];
    for &(ctx, sym) in syms {
        hists[usize::from(ctx)][usize::from(sym)] += 1;
    }
    let tables: Vec<FreqTable> = hists.iter().map(FreqTable::from_histogram).collect();
    for table in &tables {
        table.serialize(out);
    }
    let tokens = encode_symbols(&tables, syms);
    let raw_bytes = raw.finish();
    out.extend_from_slice(&(tokens.len() as u32).to_le_bytes());
    out.extend_from_slice(&(raw_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&tokens);
    out.extend_from_slice(&raw_bytes);
}

/// Распарсенная секция: таблицы и срезы потоков.
pub struct Section<'a> {
    pub tables: Vec<FreqTable>,
    pub tokens: &'a [u8],
    pub raw: &'a [u8],
}

/// Читает секцию с начала `bytes`; возвращает секцию и число съеденных байт.
pub fn read_section(bytes: &[u8], n_ctx: usize) -> Result<(Section<'_>, usize), DecodeError> {
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
