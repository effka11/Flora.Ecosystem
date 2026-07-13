//! Битовый ввод/вывод MSB-first и коды Райса (FAC.md, «Коды Райса и битовый порядок»).

use crate::error::Error;

/// Порог эскейпа унарной части кода Райса: 24 единичных бита подряд (без
/// терминирующего нуля) означают, что дальше значение записано как 32 raw-бита.
pub const RICE_ESCAPE_Q: u32 = 24;

pub fn zigzag(v: i32) -> u32 {
    ((v as u32) << 1) ^ ((v >> 31) as u32)
}

pub fn unzigzag(u: u32) -> i32 {
    ((u >> 1) as i32) ^ -((u & 1) as i32)
}

/// Точная длина `write_rice(val, k)` в битах (для rate-контроля без записи).
pub fn rice_len(val: u32, k: u32) -> u64 {
    let q = val >> k;
    if q >= RICE_ESCAPE_Q {
        u64::from(RICE_ESCAPE_Q) + 32
    } else {
        u64::from(q) + 1 + u64::from(k)
    }
}

#[derive(Default)]
pub struct BitWriter {
    bytes: Vec<u8>,
    acc: u32,
    nacc: u32,
}

impl BitWriter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn write_bit(&mut self, bit: bool) {
        self.acc = (self.acc << 1) | u32::from(bit);
        self.nacc += 1;
        if self.nacc == 8 {
            self.bytes.push(self.acc as u8);
            self.acc = 0;
            self.nacc = 0;
        }
    }

    /// Пишет `n` младших битов `val`, старшим битом вперёд. `n <= 32`.
    pub fn write_bits(&mut self, val: u32, n: u32) {
        debug_assert!(n <= 32);
        for i in (0..n).rev() {
            self.write_bit((val >> i) & 1 == 1);
        }
    }

    pub fn write_rice(&mut self, val: u32, k: u32) {
        let q = val >> k;
        if q >= RICE_ESCAPE_Q {
            for _ in 0..RICE_ESCAPE_Q {
                self.write_bit(true);
            }
            self.write_bits(val, 32);
        } else {
            for _ in 0..q {
                self.write_bit(true);
            }
            self.write_bit(false);
            self.write_bits(val & ((1u32 << k) - 1).max(0), k);
        }
    }

    pub fn bit_len(&self) -> u64 {
        self.bytes.len() as u64 * 8 + u64::from(self.nacc)
    }

    /// Выравнивание нулями до байта и выдача буфера.
    pub fn finish(mut self) -> Vec<u8> {
        if self.nacc > 0 {
            self.acc <<= 8 - self.nacc;
            self.bytes.push(self.acc as u8);
        }
        self.bytes
    }
}

pub struct BitReader<'a> {
    data: &'a [u8],
    pos: u64,
}

impl<'a> BitReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    pub fn bit_pos(&self) -> u64 {
        self.pos
    }

    pub fn read_bit(&mut self) -> Result<u32, Error> {
        let byte = self.pos / 8;
        if byte >= self.data.len() as u64 {
            return Err(Error::Truncated);
        }
        let shift = 7 - (self.pos % 8) as u32;
        self.pos += 1;
        Ok(u32::from(self.data[byte as usize] >> shift) & 1)
    }

    pub fn read_bits(&mut self, n: u32) -> Result<u32, Error> {
        debug_assert!(n <= 32);
        let mut v = 0u32;
        for _ in 0..n {
            v = (v << 1) | self.read_bit()?;
        }
        Ok(v)
    }

    pub fn read_rice(&mut self, k: u32) -> Result<u32, Error> {
        let mut q = 0u32;
        loop {
            if self.read_bit()? == 0 {
                break;
            }
            q += 1;
            if q == RICE_ESCAPE_Q {
                return self.read_bits(32);
            }
        }
        Ok((q << k) | self.read_bits(k)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zigzag_roundtrip() {
        for v in [0, 1, -1, 2, -2, 1000, -1000, i32::MAX, i32::MIN] {
            assert_eq!(unzigzag(zigzag(v)), v);
        }
    }

    #[test]
    fn rice_roundtrip_and_len() {
        let values = [0u32, 1, 2, 7, 8, 100, 1000, 65_535, u32::MAX];
        for k in 0..=7u32 {
            let mut w = BitWriter::new();
            let mut expected_bits = 0u64;
            for &v in &values {
                w.write_rice(v, k);
                expected_bits += rice_len(v, k);
            }
            assert_eq!(w.bit_len(), expected_bits);
            let bytes = w.finish();
            let mut r = BitReader::new(&bytes);
            for &v in &values {
                assert_eq!(r.read_rice(k).unwrap(), v);
            }
        }
    }

    #[test]
    fn bits_roundtrip() {
        let mut w = BitWriter::new();
        w.write_bits(0b1011, 4);
        w.write_bits(0xDEAD_BEEF, 32);
        w.write_bits(1, 1);
        let bytes = w.finish();
        let mut r = BitReader::new(&bytes);
        assert_eq!(r.read_bits(4).unwrap(), 0b1011);
        assert_eq!(r.read_bits(32).unwrap(), 0xDEAD_BEEF);
        assert_eq!(r.read_bits(1).unwrap(), 1);
    }

    #[test]
    fn truncated_read_is_error() {
        let mut r = BitReader::new(&[0xFF]);
        assert_eq!(r.read_bits(8).unwrap(), 0xFF);
        assert_eq!(r.read_bit(), Err(Error::Truncated));
    }
}
