//! Детерминированная **байтовая** сериализация (FGP-CRYPTO §10: «спецификация — это байты»).
//!
//! JSON-порядок и пробелы не годятся для consensus-хешей; вместо этого — явный
//! длиннопрефиксный бинарный формат с фиксированным порядком полей. Один и тот же вход даёт
//! один и тот же байтовый образ на сервере и в wasm-клиенте, поэтому хеш журнала совпадает.
//!
//! Кодирование:
//! - целые — big-endian фиксированной ширины (`u8/u16/u32/u64/i64`);
//! - байтовые срезы — `u32` длина (BE) + сами байты;
//! - строки — как байтовые срезы их UTF-8;
//! - варианты enum — ведущий `u8`-тег.

use crate::amount::{AccountId, Grains, Timestamp};
use crate::hash::Hash32;

/// Аккумулятор канонических байт.
#[derive(Debug, Default, Clone)]
pub struct CanonicalWriter {
    buf: Vec<u8>,
}

impl CanonicalWriter {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    pub fn u8(&mut self, v: u8) -> &mut Self {
        self.buf.push(v);
        self
    }

    pub fn u16(&mut self, v: u16) -> &mut Self {
        self.buf.extend_from_slice(&v.to_be_bytes());
        self
    }

    pub fn u32(&mut self, v: u32) -> &mut Self {
        self.buf.extend_from_slice(&v.to_be_bytes());
        self
    }

    pub fn u64(&mut self, v: u64) -> &mut Self {
        self.buf.extend_from_slice(&v.to_be_bytes());
        self
    }

    pub fn i64(&mut self, v: i64) -> &mut Self {
        self.buf.extend_from_slice(&v.to_be_bytes());
        self
    }

    /// Длиннопрефиксный байтовый срез (`u32` длина + байты).
    pub fn bytes(&mut self, v: &[u8]) -> &mut Self {
        self.u32(v.len() as u32);
        self.buf.extend_from_slice(v);
        self
    }

    pub fn str(&mut self, v: &str) -> &mut Self {
        self.bytes(v.as_bytes())
    }

    pub fn hash(&mut self, v: &Hash32) -> &mut Self {
        self.buf.extend_from_slice(v);
        self
    }

    pub fn account(&mut self, v: &AccountId) -> &mut Self {
        self.buf.extend_from_slice(&v.0);
        self
    }

    /// `Option<AccountId>`: тег присутствия + значение.
    pub fn opt_account(&mut self, v: &Option<AccountId>) -> &mut Self {
        match v {
            Some(a) => {
                self.u8(1);
                self.account(a);
            }
            None => {
                self.u8(0);
            }
        }
        self
    }

    pub fn grains(&mut self, v: Grains) -> &mut Self {
        self.i64(v.0)
    }

    pub fn timestamp(&mut self, v: Timestamp) -> &mut Self {
        self.i64(v.0)
    }

    /// Список аккаунтов (для путей взаимного кредита): длина + элементы по порядку.
    pub fn account_list(&mut self, v: &[AccountId]) -> &mut Self {
        self.u32(v.len() as u32);
        for a in v {
            self.account(a);
        }
        self
    }

    /// Готовые байты (забирает буфер, писатель можно не использовать дальше).
    pub fn finish(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.buf)
    }

    /// Заимствовать текущий буфер.
    pub fn as_slice(&self) -> &[u8] {
        &self.buf
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integers_are_big_endian_fixed_width() {
        let bytes = CanonicalWriter::new().u32(1).u64(2).finish();
        assert_eq!(
            bytes,
            vec![
                0, 0, 0, 1, /* u32=1 */ 0, 0, 0, 0, 0, 0, 0, 2 /* u64=2 */
            ]
        );
    }

    #[test]
    fn bytes_are_length_prefixed() {
        let bytes = CanonicalWriter::new().str("ab").finish();
        assert_eq!(bytes, vec![0, 0, 0, 2, b'a', b'b']);
    }

    #[test]
    fn encoding_is_deterministic() {
        let a = AccountId([7u8; 16]);
        let mk = || {
            CanonicalWriter::new()
                .u8(3)
                .account(&a)
                .grains(Grains(42))
                .timestamp(Timestamp(1000))
                .finish()
        };
        assert_eq!(mk(), mk());
    }

    #[test]
    fn distinct_values_produce_distinct_bytes() {
        let a = CanonicalWriter::new().grains(Grains(1)).finish();
        let b = CanonicalWriter::new().grains(Grains(2)).finish();
        assert_ne!(a, b);
    }
}
