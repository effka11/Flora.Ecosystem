//! Битовые потоки для «сырых» бит (raw-bits section, FIC.md §5.3).
//!
//! Порядок: биты пишутся и читаются MSB-first внутри байта. Последний байт
//! дописывается нулями. Чтение за концом буфера — `DecodeError::Corrupt`.

use crate::error::DecodeError;

/// Пишущий битовый поток.
#[derive(Default)]
pub struct BitWriter {
    bytes: Vec<u8>,
    acc: u32,
    nbits: u32,
}

impl BitWriter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Записывает младшие `nbits` бит `value` (0..=24 бит за вызов).
    pub fn write(&mut self, value: u32, nbits: u32) {
        debug_assert!(nbits <= 24);
        if nbits == 0 {
            return;
        }
        debug_assert!(value < (1u32 << nbits));
        let mask = (1u32 << nbits) - 1;
        self.acc = (self.acc << nbits) | (value & mask);
        self.nbits += nbits;
        while self.nbits >= 8 {
            self.nbits -= 8;
            self.bytes.push((self.acc >> self.nbits) as u8);
        }
    }

    /// Завершает поток, дописывая незаполненный байт нулями.
    pub fn finish(mut self) -> Vec<u8> {
        if self.nbits > 0 {
            self.bytes.push((self.acc << (8 - self.nbits)) as u8);
        }
        self.bytes
    }

    /// Число бит, записанных к текущему моменту.
    pub fn bit_len(&self) -> u64 {
        self.bytes.len() as u64 * 8 + u64::from(self.nbits)
    }
}

/// Читающий битовый поток поверх среза.
pub struct BitReader<'a> {
    bytes: &'a [u8],
    pos: usize,
    acc: u32,
    nbits: u32,
}

impl<'a> BitReader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0, acc: 0, nbits: 0 }
    }

    /// Число целых байт, ещё не тронутых чтением (хвост после последнего
    /// востребованного байта). У честного потока после декодирования — 0.
    pub fn unread_bytes(&self) -> usize {
        self.bytes.len() - self.pos
    }

    /// Читает `nbits` бит (0..=24). За концом буфера — ошибка.
    pub fn read(&mut self, nbits: u32) -> Result<u32, DecodeError> {
        debug_assert!(nbits <= 24);
        while self.nbits < nbits {
            let Some(&b) = self.bytes.get(self.pos) else {
                return Err(DecodeError::Corrupt("raw-bits: чтение за концом секции"));
            };
            self.pos += 1;
            self.acc = (self.acc << 8) | u32::from(b);
            self.nbits += 8;
        }
        self.nbits -= nbits;
        let v = (self.acc >> self.nbits) & if nbits == 0 { 0 } else { (1u32 << nbits) - 1 };
        Ok(v)
    }
}
