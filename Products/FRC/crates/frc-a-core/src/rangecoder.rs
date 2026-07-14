//! Бинарный range coder (FRC-A.md, «Энтропийное кодирование»).
//!
//! Классическая схема LZMA-типа: 32-битный `range`, байтовая ренормализация,
//! перенос через `low: u64`, вероятности с точностью 12 бит (масштаб 4096).
//! Статические вероятности задаются нормативными константами кодека — энкодер
//! и декодер не адаптируются, поэтому стоимость каждого символа известна
//! заранее (точные таблицы в 1/64 бита для rate-контроля).
//!
//! Формат потока: 1 ведущий байт (всегда 0, артефакт инициализации кэша),
//! далее байты кода; финализация выталкивает 5 байтов. Декодер читает ведущий
//! байт + 4 байта инициализации; чтение за концом буфера фиксируется флагом
//! `overrun` (усечённый пакет), данные при этом читаются как нули.

const TOP: u32 = 1 << 24;
const PROB_BITS: u32 = 12;

/// Вероятность «бит = 0» в масштабе 4096; допустимы значения `1..=4095`.
pub type Prob0 = u16;

/// Ровно 1 бит на символ (сырые биты).
pub const P0_HALF: Prob0 = 2048;

/// Адаптивная вероятность LZMA-типа: после каждого бита сдвигается на 1/32
/// к наблюдённому значению. Значения остаются в (0, 4096) при любой истории.
/// Контексты живут в пределах кадра (сбрасываются на границе) — потеря пакета
/// не рассинхронизирует энкодер и декодер.
#[derive(Clone, Copy)]
pub struct AdaptiveProb(Prob0);

impl AdaptiveProb {
    const SHIFT: u32 = 5;

    pub fn new(init: Prob0) -> Self {
        debug_assert!((1..4096).contains(&init));
        Self(init)
    }

    pub fn prob0(&self) -> Prob0 {
        self.0
    }

    pub fn update(&mut self, bit: bool) {
        if bit {
            self.0 -= self.0 >> Self::SHIFT;
        } else {
            self.0 += (4096 - self.0) >> Self::SHIFT;
        }
    }
}

/// Верхняя оценка стоимости бита в 1/64 бита: `768 − log2_x64(freq)`,
/// где `log2_x64` занижает не более чем на ~2/64 бита (см. `qmath`).
/// Детерминированный учёт для rate-контроля — без float.
pub fn bit_cost_x64(prob0: Prob0, bit: bool) -> u64 {
    let freq = if bit {
        4096 - u32::from(prob0)
    } else {
        u32::from(prob0)
    };
    768 - crate::qmath::log2_x64(freq)
}

impl BinEncoder {
    pub fn encode_bit_adaptive(&mut self, prob: &mut AdaptiveProb, bit: bool) {
        self.encode_bit(prob.prob0(), bit);
        prob.update(bit);
    }
}

impl BinDecoder<'_> {
    /// Декодирует бит и добавляет его стоимость (по вероятности до обновления)
    /// в `cost` — для воспроизведения учёта энкодера на стороне декодера.
    pub fn decode_bit_adaptive(&mut self, prob: &mut AdaptiveProb, cost: &mut u64) -> bool {
        let bit = self.decode_bit(prob.prob0());
        *cost += bit_cost_x64(prob.prob0(), bit);
        prob.update(bit);
        bit
    }
}

pub struct BinEncoder {
    low: u64,
    range: u32,
    cache: u8,
    cache_size: u64,
    out: Vec<u8>,
}

impl Default for BinEncoder {
    fn default() -> Self {
        Self::new()
    }
}

impl BinEncoder {
    pub fn new() -> Self {
        Self {
            low: 0,
            range: u32::MAX,
            cache: 0,
            cache_size: 1,
            out: Vec::new(),
        }
    }

    pub fn encode_bit(&mut self, prob0: Prob0, bit: bool) {
        debug_assert!((1..1 << PROB_BITS).contains(&u32::from(prob0)));
        let bound = (self.range >> PROB_BITS) * u32::from(prob0);
        if !bit {
            self.range = bound;
        } else {
            self.low += u64::from(bound);
            self.range -= bound;
        }
        while self.range < TOP {
            self.shift_low();
            self.range <<= 8;
        }
    }

    /// `n` сырых битов MSB-first, ровно по биту на бит.
    pub fn encode_bits(&mut self, value: u32, n: u32) {
        for i in (0..n).rev() {
            self.encode_bit(P0_HALF, (value >> i) & 1 != 0);
        }
    }

    fn shift_low(&mut self) {
        if self.low < 0xFF00_0000 || self.low > 0xFFFF_FFFF {
            let carry = (self.low >> 32) as u8;
            if self.cache_size > 0 {
                self.out.push(self.cache.wrapping_add(carry));
                for _ in 1..self.cache_size {
                    self.out.push(0xFFu8.wrapping_add(carry));
                }
                self.cache_size = 0;
            }
            self.cache = (self.low >> 24) as u8;
        }
        self.cache_size += 1;
        self.low = (self.low << 8) & 0xFFFF_FFFF;
    }

    /// Завершает поток (5 байтов) и возвращает байты.
    pub fn finish(mut self) -> Vec<u8> {
        for _ in 0..5 {
            self.shift_low();
        }
        self.out
    }
}

pub struct BinDecoder<'a> {
    buf: &'a [u8],
    pos: usize,
    code: u32,
    range: u32,
    overrun: bool,
}

impl<'a> BinDecoder<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        let mut d = Self {
            buf,
            pos: 0,
            code: 0,
            range: u32::MAX,
            overrun: false,
        };
        d.next_byte(); // ведущий байт (игнорируется)
        for _ in 0..4 {
            let b = d.next_byte();
            d.code = (d.code << 8) | u32::from(b);
        }
        d
    }

    fn next_byte(&mut self) -> u8 {
        if self.pos < self.buf.len() {
            let b = self.buf[self.pos];
            self.pos += 1;
            b
        } else {
            self.overrun = true;
            0
        }
    }

    pub fn decode_bit(&mut self, prob0: Prob0) -> bool {
        debug_assert!((1..1 << PROB_BITS).contains(&u32::from(prob0)));
        let bound = (self.range >> PROB_BITS) * u32::from(prob0);
        let bit = self.code >= bound;
        if !bit {
            self.range = bound;
        } else {
            self.code -= bound;
            self.range -= bound;
        }
        while self.range < TOP {
            let b = self.next_byte();
            self.code = (self.code << 8) | u32::from(b);
            self.range <<= 8;
        }
        bit
    }

    pub fn decode_bits(&mut self, n: u32) -> u32 {
        let mut v = 0u32;
        for _ in 0..n {
            v = (v << 1) | u32::from(self.decode_bit(P0_HALF));
        }
        v
    }

    /// Был ли выход за конец буфера (усечённый/повреждённый пакет).
    pub fn overrun(&self) -> bool {
        self.overrun
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xorshift(state: &mut u32) -> u32 {
        *state ^= *state << 13;
        *state ^= *state >> 17;
        *state ^= *state << 5;
        *state
    }

    #[test]
    fn roundtrip_random_bits_and_probs() {
        let mut state = 0x5EC0_DE01u32;
        for round in 0..20 {
            let n = 1 + (xorshift(&mut state) % 5000) as usize;
            let mut bits = Vec::with_capacity(n);
            let mut probs = Vec::with_capacity(n);
            for _ in 0..n {
                let p = 1 + (xorshift(&mut state) % 4095) as u16;
                // Смещаем биты в сторону вероятной стороны, чтобы поток был реалистичным.
                let bit = xorshift(&mut state) % 4096 >= u32::from(p);
                bits.push(bit);
                probs.push(p);
            }
            let mut enc = BinEncoder::new();
            for (&b, &p) in bits.iter().zip(&probs) {
                enc.encode_bit(p, b);
            }
            let stream = enc.finish();
            let mut dec = BinDecoder::new(&stream);
            for (i, (&b, &p)) in bits.iter().zip(&probs).enumerate() {
                assert_eq!(dec.decode_bit(p), b, "round {round}, bit {i}");
            }
            assert!(!dec.overrun(), "round {round}: overrun on valid stream");
        }
    }

    #[test]
    fn roundtrip_raw_bits() {
        let mut enc = BinEncoder::new();
        enc.encode_bits(0xDEAD_BEEF, 32);
        enc.encode_bits(0b101, 3);
        enc.encode_bits(0, 1);
        let stream = enc.finish();
        let mut dec = BinDecoder::new(&stream);
        assert_eq!(dec.decode_bits(32), 0xDEAD_BEEF);
        assert_eq!(dec.decode_bits(3), 0b101);
        assert_eq!(dec.decode_bits(1), 0);
        assert!(!dec.overrun());
    }

    #[test]
    fn long_skewed_runs_are_compact() {
        // 10_000 «вероятных» битов при p0 = 4000/4096 должны сжаться до ~ n·(−log2 p).
        let n = 10_000;
        let mut enc = BinEncoder::new();
        for _ in 0..n {
            enc.encode_bit(4000, false);
        }
        let stream = enc.finish();
        let expected_bits = f64::from(n) * -(4000f64 / 4096.0).log2();
        let got_bits = stream.len() as f64 * 8.0;
        assert!(
            got_bits < expected_bits + 96.0,
            "stream too large: {got_bits} vs entropy {expected_bits:.0}"
        );
        let mut dec = BinDecoder::new(&stream);
        for i in 0..n {
            assert!(!dec.decode_bit(4000), "bit {i}");
        }
        assert!(!dec.overrun());
    }

    #[test]
    fn truncated_stream_sets_overrun() {
        let mut enc = BinEncoder::new();
        for i in 0..256u32 {
            enc.encode_bits(i, 8);
        }
        let stream = enc.finish();
        let cut = &stream[..stream.len() / 2];
        let mut dec = BinDecoder::new(cut);
        for _ in 0..256 {
            let _ = dec.decode_bits(8);
        }
        assert!(dec.overrun(), "half stream must overrun");

        let mut dec_empty = BinDecoder::new(&[]);
        let _ = dec_empty.decode_bit(P0_HALF);
        assert!(dec_empty.overrun());
    }

    #[test]
    fn empty_payload_roundtrip() {
        let stream = BinEncoder::new().finish();
        assert!(stream.len() <= 6);
        let dec = BinDecoder::new(&stream);
        assert!(!dec.overrun());
    }
}
