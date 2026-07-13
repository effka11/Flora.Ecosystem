//! Hybrid-uint токенизация (FIC.md §5.4).
//!
//! Целое `v < 2^20` разбивается на токен (алфавит 32 символа) и «сырые» биты:
//! - `v < 16` — токен равен `v`, сырых бит нет;
//! - иначе токен кодирует битовую длину `n` (`16 + n - 5`), а `v - 2^(n-1)`
//!   уходит в raw-bits поток (`n - 1` бит).
//!
//! Малый алфавит держит rANS-таблицы компактными; старшие биты больших значений
//! почти не сжимаются, поэтому хранить их сырыми — выгоднее и быстрее.

use crate::bits::{BitReader, BitWriter};
use crate::error::DecodeError;

/// Размер алфавита токенов (символы 0..=31).
pub const ALPHABET: usize = 32;

/// Максимальное кодируемое значение (исключительно): 2^20.
pub const MAX_VALUE: u32 = 1 << 20;

/// Отображение знакового значения в беззнаковое: 0, -1, 1, -2, 2 → 0, 1, 2, 3, 4.
#[inline]
pub fn zigzag(v: i32) -> u32 {
    ((v << 1) ^ (v >> 31)) as u32
}

/// Обратное отображение `zigzag`.
#[inline]
pub fn unzigzag(u: u32) -> i32 {
    ((u >> 1) as i32) ^ -((u & 1) as i32)
}

/// Токенизирует значение: возвращает `(символ, сырые биты, число сырых бит)`.
#[inline]
pub fn tokenize(v: u32) -> (u8, u32, u32) {
    debug_assert!(v < MAX_VALUE);
    if v < 16 {
        (v as u8, 0, 0)
    } else {
        let n = 32 - v.leading_zeros(); // 5..=20
        let raw_bits = n - 1;
        let raw = v - (1u32 << raw_bits);
        ((16 + n - 5) as u8, raw, raw_bits)
    }
}

/// Записывает сырые биты токена в raw-поток.
#[inline]
pub fn write_raw(writer: &mut BitWriter, raw: u32, raw_bits: u32) {
    writer.write(raw, raw_bits);
}

/// Восстанавливает значение по символу, дочитывая сырые биты.
#[inline]
pub fn detokenize(sym: u8, reader: &mut BitReader<'_>) -> Result<u32, DecodeError> {
    if sym < 16 {
        return Ok(u32::from(sym));
    }
    let n = u32::from(sym) - 16 + 5; // 5..=20 (символ < 32 гарантирован таблицей частот)
    if n > 20 {
        return Err(DecodeError::Corrupt("token: символ вне диапазона hybrid-uint"));
    }
    let raw_bits = n - 1;
    let raw = reader.read(raw_bits)?;
    Ok((1u32 << raw_bits) + raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zigzag_roundtrip() {
        for v in [-524_288, -1000, -2, -1, 0, 1, 2, 1000, 524_287] {
            assert_eq!(unzigzag(zigzag(v)), v);
        }
    }

    #[test]
    fn tokenize_roundtrip() {
        let values: Vec<u32> = (0..2000).chain([4095, 65_535, MAX_VALUE - 1]).collect();
        let mut writer = BitWriter::new();
        let mut syms = Vec::new();
        for &v in &values {
            let (sym, raw, raw_bits) = tokenize(v);
            assert!(usize::from(sym) < ALPHABET);
            write_raw(&mut writer, raw, raw_bits);
            syms.push(sym);
        }
        let bytes = writer.finish();
        let mut reader = BitReader::new(&bytes);
        for (&v, &sym) in values.iter().zip(&syms) {
            assert_eq!(detokenize(sym, &mut reader).unwrap(), v);
        }
    }
}
