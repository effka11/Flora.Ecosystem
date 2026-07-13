//! Адаптивный бинарный range-coder (энтропийное ядро FVC1).
//!
//! Классическая byte-wise схема с 32-битным range и переносом через cache/FF-счётчик
//! (как в LZMA rc). Вероятности — 15-битные (1..=32767 = P(bit==0)·32768), адаптация
//! сдвигом `ADAPT_SHIFT` после каждого бита; энкодер и декодер обновляют модель зеркально.
//!
//! Нормативно: поведение декодера при исчерпании входа — виртуальные нулевые байты
//! (декодер никогда не паникует; завершение гарантируют внешние счётчики синтаксиса).

use crate::tables::BIT_COST_256;

const TOP: u32 = 1 << 24;
pub const PROB_BITS: u32 = 15;
pub const PROB_ONE: u16 = 1 << PROB_BITS; // 32768, недостижимая "единица"
pub const PROB_HALF: u16 = 1 << (PROB_BITS - 1);
const ADAPT_SHIFT: u32 = 5;

/// Адаптивная вероятность нуля.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Prob(pub u16);

impl Default for Prob {
    fn default() -> Self {
        Prob(PROB_HALF)
    }
}

impl Prob {
    #[inline]
    pub fn new(p: u16) -> Self {
        debug_assert!(p >= 1 && p < PROB_ONE);
        Prob(p)
    }

    /// Обновление модели после кодирования/декодирования бита.
    #[inline]
    fn adapt(&mut self, bit: bool) {
        if bit {
            self.0 -= self.0 >> ADAPT_SHIFT;
            if self.0 == 0 {
                self.0 = 1;
            }
        } else {
            self.0 += (PROB_ONE - self.0) >> ADAPT_SHIFT;
        }
    }

    /// Стоимость кодирования бита в 1/256 бита (для RD-оценок энкодера).
    #[inline]
    pub fn cost(&self, bit: bool) -> u32 {
        let idx0 = (self.0 >> (PROB_BITS - 8)) as usize; // 0..=255
        let idx = if bit { 256 - idx0 } else { idx0 };
        u32::from(BIT_COST_256[idx.min(255)])
    }
}

/// Энкодер.
pub struct BoolEncoder {
    low: u64,
    range: u32,
    cache: u8,
    cache_size: u64,
    out: Vec<u8>,
}

impl Default for BoolEncoder {
    fn default() -> Self {
        Self::new()
    }
}

impl BoolEncoder {
    pub fn new() -> Self {
        BoolEncoder { low: 0, range: u32::MAX, cache: 0, cache_size: 1, out: Vec::new() }
    }

    #[inline]
    fn shift_low(&mut self) {
        if (self.low as u32) < 0xFF00_0000 || (self.low >> 32) != 0 {
            let carry = (self.low >> 32) as u8;
            let mut byte = self.cache;
            loop {
                self.out.push(byte.wrapping_add(carry));
                byte = 0xFF;
                self.cache_size -= 1;
                if self.cache_size == 0 {
                    break;
                }
            }
            self.cache = (self.low >> 24) as u8;
        }
        self.cache_size += 1;
        self.low = (self.low << 8) & 0xFFFF_FFFF;
    }

    /// Кодирует бит с адаптивной вероятностью.
    #[inline]
    pub fn put(&mut self, prob: &mut Prob, bit: bool) {
        let bound = u64::from(self.range >> PROB_BITS) * u64::from(prob.0);
        let bound = bound as u32;
        if bit {
            self.low += u64::from(bound);
            self.range -= bound;
        } else {
            self.range = bound;
        }
        prob.adapt(bit);
        while self.range < TOP {
            self.shift_low();
            self.range <<= 8;
        }
    }

    /// Кодирует бит с фиксированной вероятностью 1/2 (без адаптации).
    #[inline]
    pub fn put_raw(&mut self, bit: bool) {
        let bound = self.range >> 1;
        if bit {
            self.low += u64::from(bound);
            self.range -= bound;
        } else {
            self.range = bound;
        }
        while self.range < TOP {
            self.shift_low();
            self.range <<= 8;
        }
    }

    /// Кодирует `n` сырых бит (старший — первым).
    #[inline]
    pub fn put_raw_bits(&mut self, value: u32, n: u32) {
        for i in (0..n).rev() {
            self.put_raw((value >> i) & 1 == 1);
        }
    }

    /// Завершает поток и возвращает байты.
    pub fn finish(mut self) -> Vec<u8> {
        for _ in 0..5 {
            self.shift_low();
        }
        // Первый байт всегда 0 (инициализация cache) — декодер его пропускает.
        self.out
    }
}

/// Декодер. На исчерпании входа продолжает с нулевыми байтами.
pub struct BoolDecoder<'a> {
    data: &'a [u8],
    pos: usize,
    code: u32,
    range: u32,
}

impl<'a> BoolDecoder<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        let mut d = BoolDecoder { data, pos: 0, code: 0, range: u32::MAX };
        d.next_byte(); // нулевой стартовый байт энкодера
        for _ in 0..4 {
            let b = d.next_byte();
            d.code = (d.code << 8) | u32::from(b);
        }
        d
    }

    #[inline]
    fn next_byte(&mut self) -> u8 {
        if self.pos < self.data.len() {
            let b = self.data[self.pos];
            self.pos += 1;
            b
        } else {
            0
        }
    }

    /// Декодирует бит с адаптивной вероятностью.
    #[inline]
    pub fn get(&mut self, prob: &mut Prob) -> bool {
        let bound = (u64::from(self.range >> PROB_BITS) * u64::from(prob.0)) as u32;
        let bit = self.code >= bound;
        if bit {
            self.code -= bound;
            self.range -= bound;
        } else {
            self.range = bound;
        }
        prob.adapt(bit);
        while self.range < TOP {
            let b = self.next_byte();
            self.code = (self.code << 8) | u32::from(b);
            self.range <<= 8;
        }
        bit
    }

    /// Декодирует бит с фиксированной вероятностью 1/2.
    #[inline]
    pub fn get_raw(&mut self) -> bool {
        let bound = self.range >> 1;
        let bit = self.code >= bound;
        if bit {
            self.code -= bound;
            self.range -= bound;
        } else {
            self.range = bound;
        }
        while self.range < TOP {
            let b = self.next_byte();
            self.code = (self.code << 8) | u32::from(b);
            self.range <<= 8;
        }
        bit
    }

    /// Декодирует `n` сырых бит (старший — первым).
    #[inline]
    pub fn get_raw_bits(&mut self, n: u32) -> u32 {
        let mut v = 0;
        for _ in 0..n {
            v = (v << 1) | u32::from(self.get_raw());
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Детерминированный LCG, чтобы не тянуть rand.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u32 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (self.0 >> 33) as u32
        }
    }

    #[test]
    fn roundtrip_random_bits_and_probs() {
        let mut rng = Lcg(0x5EED_F10A);
        // Несколько прогонов с разными наборами контекстов.
        for run in 0..8u32 {
            let n = 20_000 + (run * 3_777) as usize;
            let mut probs_enc: Vec<Prob> = (0..17).map(|i| Prob::new(1 + (i * 1931) % 32700)).collect();
            let mut probs_dec = probs_enc.clone();
            let mut bits = Vec::with_capacity(n);
            let mut ctxs = Vec::with_capacity(n);
            let mut enc = BoolEncoder::new();
            for _ in 0..n {
                let ctx = (rng.next() % 17) as usize;
                // Скошенный источник: чаще нули.
                let bit = rng.next() % 100 < 23 + (ctx as u32);
                enc.put(&mut probs_enc[ctx], bit);
                bits.push(bit);
                ctxs.push(ctx);
            }
            // Вперемешку сырые биты.
            enc.put_raw_bits(0xA5F0_1234, 32);
            let data = enc.finish();

            let mut dec = BoolDecoder::new(&data);
            for i in 0..n {
                let bit = dec.get(&mut probs_dec[ctxs[i]]);
                assert_eq!(bit, bits[i], "bit {i} mismatch (run {run})");
            }
            assert_eq!(dec.get_raw_bits(32), 0xA5F0_1234);
            assert_eq!(probs_enc, probs_dec, "модели энкодера и декодера разошлись");
        }
    }

    #[test]
    fn skewed_source_compresses() {
        let mut rng = Lcg(42);
        let n = 100_000;
        let mut p = Prob::default();
        let mut enc = BoolEncoder::new();
        for _ in 0..n {
            enc.put(&mut p, rng.next() % 100 < 3);
        }
        let data = enc.finish();
        // Энтропия источника ~0.19 бит/бит: ждём < 0.25 бита на символ.
        assert!(data.len() * 8 < n / 4, "len={} bytes for {} bits", data.len(), n);
    }

    #[test]
    fn decoder_survives_truncation() {
        let mut enc = BoolEncoder::new();
        let mut p = Prob::default();
        for i in 0..1000 {
            enc.put(&mut p, i % 3 == 0);
        }
        let data = enc.finish();
        for cut in 0..data.len() {
            let mut dec = BoolDecoder::new(&data[..cut]);
            let mut p2 = Prob::default();
            for _ in 0..1000 {
                let _ = dec.get(&mut p2); // не должен паниковать
            }
        }
    }
}
