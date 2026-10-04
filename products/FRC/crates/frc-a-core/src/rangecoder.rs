//! Бинарный range coder (FRC-A.md, «Энтропийное кодирование»).
//!
//! Классическая схема LZMA-типа: 32-битный `range`, байтовая ренормализация,
//! перенос через `low: u64`, вероятности с точностью 12 бит (масштаб 4096).
//!
//! Формат потока: байты кода без ведущего байта — первый байт классической
//! LZMA-схемы всегда 0 (пока не был вытолкнут ни один байт, инвариант
//! `low + range ≤ 2³²` сохраняется и перенос в начальный кэш невозможен),
//! поэтому энкодер его не передаёт, а декодер не пропускает. Финализация
//! выталкивает 5 байтов (40 бит накладных). Декодер читает 4 байта
//! инициализации `code`; чтение за концом буфера фиксируется флагом `overrun`
//! (усечённый пакет), данные при этом читаются как нули.

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

    /// Равномерный символ `x ∈ [0, m)`: цепочка двоичных делений интервала
    /// пополам с вероятностью, пропорциональной мощностям половин
    /// (`uniform_split`). Телескопирование делает стоимость ≈ `log2 m` бит
    /// для любого `m`, не только степеней двойки.
    pub fn encode_uniform(&mut self, x: u64, m: u64) {
        debug_assert!(x < m);
        let (mut lo, mut hi) = (0u64, m);
        while hi - lo > 1 {
            let (mid, p0) = uniform_split(lo, hi);
            let bit = x >= mid;
            self.encode_bit(p0, bit);
            if bit {
                lo = mid;
            } else {
                hi = mid;
            }
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

    /// Завершает поток (выталкивает 5 байтов) и возвращает байты без ведущего
    /// нулевого байта (см. заголовок модуля).
    pub fn finish(mut self) -> Vec<u8> {
        for _ in 0..5 {
            self.shift_low();
        }
        debug_assert_eq!(self.out[0], 0, "первый байт LZMA-схемы обязан быть 0");
        self.out.remove(0);
        self.out
    }
}

/// Нормативное деление интервала `[lo, hi)` равномерного символа: середина и
/// вероятность нижней половины `p0 = round(4096·(mid−lo)/(hi−lo))`, кламп в
/// `[1, 4095]`. Общая функция энкодера и декодера.
fn uniform_split(lo: u64, hi: u64) -> (u64, Prob0) {
    let mid = lo + (hi - lo) / 2;
    let n = u128::from(hi - lo);
    let n0 = u128::from(mid - lo);
    let p0 = ((n0 * 4096 + n / 2) / n) as u16;
    (mid, p0.clamp(1, 4095))
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

    /// Равномерный символ `∈ [0, m)` — зеркало `encode_uniform` (те же деления
    /// и вероятности `uniform_split`). Результат всегда `< m`.
    pub fn decode_uniform(&mut self, m: u64) -> u64 {
        let (mut lo, mut hi) = (0u64, m);
        while hi - lo > 1 {
            let (mid, p0) = uniform_split(lo, hi);
            if self.decode_bit(p0) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        lo
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
        assert!(stream.len() <= 5);
        let dec = BinDecoder::new(&stream);
        assert!(!dec.overrun());
    }

    #[test]
    fn uniform_roundtrip_various_alphabets() {
        let mut state = 0xC0DE_2026u32;
        let alphabets = [
            2u64,
            3,
            5,
            17,
            100,
            4096,
            4097,
            (1 << 32) - 5,
            (1 << 62) - 3,
            1 << 62,
        ];
        let mut values = Vec::new();
        let mut enc = BinEncoder::new();
        for round in 0..200 {
            let m = alphabets[round % alphabets.len()];
            let x = (u64::from(xorshift(&mut state)) << 32 | u64::from(xorshift(&mut state))) % m;
            enc.encode_uniform(x, m);
            values.push((x, m));
        }
        let stream = enc.finish();
        let mut dec = BinDecoder::new(&stream);
        for (i, &(x, m)) in values.iter().enumerate() {
            assert_eq!(dec.decode_uniform(m), x, "symbol {i}");
        }
        assert!(!dec.overrun());
    }

    /// Стоимость равномерного символа телескопируется к log2 m: 500 символов
    /// алфавита 1000 должны занять ≈ 500·log2(1000) бит с точностью до
    /// финализации и 12-битного округления вероятностей.
    #[test]
    fn uniform_cost_is_log2_m() {
        let n = 500u32;
        let m = 1000u64;
        let mut state = 0xFACE_0FF1u32;
        let mut enc = BinEncoder::new();
        for _ in 0..n {
            enc.encode_uniform(u64::from(xorshift(&mut state)) % m, m);
        }
        let bits = enc.finish().len() as f64 * 8.0;
        let entropy = f64::from(n) * (m as f64).log2();
        assert!(
            bits < entropy + 64.0,
            "uniform coding too fat: {bits} vs {entropy:.0}"
        );
    }

    /// Единственный значащий символ (m=1) не пишет ни бита.
    #[test]
    fn uniform_degenerate_alphabet_is_free() {
        let mut enc = BinEncoder::new();
        enc.encode_uniform(0, 1);
        enc.encode_bits(0b1011, 4);
        let stream = enc.finish();
        let mut dec = BinDecoder::new(&stream);
        assert_eq!(dec.decode_uniform(1), 0);
        assert_eq!(dec.decode_bits(4), 0b1011);
        assert!(!dec.overrun());
    }
}
