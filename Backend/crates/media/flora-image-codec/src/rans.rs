//! rANS-энтропийный кодер (range Asymmetric Numeral Systems, FIC.md §5.2).
//!
//! 32-битное состояние, побайтовая ренормализация, точность вероятностей
//! 12 бит (сумма частот таблицы всегда 4096). Кодер пишет символы в обратном
//! порядке; на проводе поток лежит так, что декодер читает строго вперёд:
//! `[state: u32 LE][байты потока]`.
//!
//! Таблицы частот статические per-tile/per-context, сериализуются разреженно
//! (§5.5): `first_sym u8, n_syms u8, затем n_syms по 12 бит (freq-1)`.

use crate::bits::{BitReader, BitWriter};
use crate::error::DecodeError;
use crate::tokens::ALPHABET;

/// Точность вероятностей: сумма частот каждой таблицы равна `1 << PROB_BITS`.
pub const PROB_BITS: u32 = 12;
/// Сумма нормализованных частот (4096).
pub const PROB_SCALE: u32 = 1 << PROB_BITS;
/// Нижняя граница состояния rANS.
const RANS_L: u32 = 1 << 23;

/// Нормализованная таблица частот одного контекста.
#[derive(Clone)]
pub struct FreqTable {
    freq: [u16; ALPHABET],
    cum: [u16; ALPHABET + 1],
}

impl FreqTable {
    /// Строит таблицу из гистограммы, нормализуя частоты к сумме 4096.
    ///
    /// Все символы непрерывного диапазона `min_used..=max_used` получают
    /// частоту >= 1 (разреженная сериализация хранит только этот диапазон).
    /// Пустая гистограмма (контекст не встретился) — вырожденная таблица
    /// `freq[0] = 4096`.
    pub fn from_histogram(hist: &[u32; ALPHABET]) -> Self {
        let total: u64 = hist.iter().map(|&h| u64::from(h)).sum();
        let mut freq = [0u16; ALPHABET];
        if total == 0 {
            freq[0] = PROB_SCALE as u16;
            return Self::from_freqs(freq);
        }
        let first = hist.iter().position(|&h| h > 0).unwrap_or(0);
        let last = hist.iter().rposition(|&h| h > 0).unwrap_or(0);

        // Первый проход: пропорциональное округление с минимумом 1 внутри диапазона.
        let mut assigned: u32 = 0;
        for i in first..=last {
            let share = (u64::from(hist[i]) * u64::from(PROB_SCALE) / total) as u32;
            let f = share.max(1);
            freq[i] = f as u16;
            assigned += f;
        }
        // Коррекция дрейфа округления: добираем/срезаем у самых частых символов.
        // Детерминированно (стабильный порядок обхода) — важно для golden-векторов.
        while assigned != PROB_SCALE {
            if assigned < PROB_SCALE {
                let i = (first..=last).max_by_key(|&i| (hist[i], usize::MAX - i)).unwrap_or(first);
                let add = (PROB_SCALE - assigned).min(u32::from(u16::MAX - freq[i]));
                freq[i] += add as u16;
                assigned += add;
            } else {
                let excess = assigned - PROB_SCALE;
                let i = (first..=last)
                    .filter(|&i| freq[i] > 1)
                    .max_by_key(|&i| (freq[i], usize::MAX - i))
                    .unwrap_or(first);
                let cut = excess.min(u32::from(freq[i]) - 1);
                freq[i] -= cut as u16;
                assigned -= cut;
                if cut == 0 {
                    // Все частоты уже 1 — недостижимо при PROB_SCALE >= ALPHABET,
                    // но защищаемся от вечного цикла.
                    freq[first] = (u32::from(freq[first]) + PROB_SCALE - assigned) as u16;
                    break;
                }
            }
        }
        Self::from_freqs(freq)
    }

    fn from_freqs(freq: [u16; ALPHABET]) -> Self {
        let mut cum = [0u16; ALPHABET + 1];
        let mut acc: u32 = 0;
        for (i, &f) in freq.iter().enumerate() {
            cum[i] = acc as u16;
            acc += u32::from(f);
        }
        cum[ALPHABET] = acc as u16; // сумма всегда 4096 — в u16 помещается
        Self { freq, cum }
    }

    /// Частота символа.
    #[inline]
    fn f(&self, sym: u8) -> u32 {
        u32::from(self.freq[usize::from(sym)])
    }

    /// Кумулятивное начало символа.
    #[inline]
    fn c(&self, sym: u8) -> u32 {
        u32::from(self.cum[usize::from(sym)])
    }

    /// Поиск символа по слоту `0..4096` (линейный проход — алфавит из 32 символов).
    #[inline]
    fn lookup(&self, slot: u32) -> u8 {
        let mut sym = 0usize;
        while sym + 1 < ALPHABET && u32::from(self.cum[sym + 1]) <= slot {
            sym += 1;
        }
        sym as u8
    }

    /// Разреженная сериализация таблицы (FIC.md §5.5).
    pub fn serialize(&self, out: &mut Vec<u8>) {
        let first = self.freq.iter().position(|&f| f > 0).unwrap_or(0);
        let last = self.freq.iter().rposition(|&f| f > 0).unwrap_or(0);
        let n = last - first + 1;
        out.push(first as u8);
        out.push(n as u8);
        let mut bits = BitWriter::new();
        for i in first..=last {
            bits.write(u32::from(self.freq[i]) - 1, 12);
        }
        out.extend_from_slice(&bits.finish());
    }

    /// Читает таблицу из среза, возвращает пару (таблица, съедено байт).
    pub fn deserialize(bytes: &[u8]) -> Result<(Self, usize), DecodeError> {
        let [first, n, rest @ ..] = bytes else {
            return Err(DecodeError::Corrupt("freq-table: обрыв заголовка"));
        };
        let first = usize::from(*first);
        let n = usize::from(*n);
        if n == 0 || first + n > ALPHABET {
            return Err(DecodeError::Corrupt("freq-table: диапазон символов вне алфавита"));
        }
        let packed_len = (n * 12).div_ceil(8);
        let Some(packed) = rest.get(..packed_len) else {
            return Err(DecodeError::Corrupt("freq-table: обрыв частот"));
        };
        let mut reader = BitReader::new(packed);
        let mut freq = [0u16; ALPHABET];
        let mut sum: u32 = 0;
        for slot in freq.iter_mut().skip(first).take(n) {
            let f = reader.read(12)? + 1;
            *slot = f as u16;
            sum += f;
        }
        if sum != PROB_SCALE {
            return Err(DecodeError::Corrupt("freq-table: сумма частот != 4096"));
        }
        Ok((Self::from_freqs(freq), 2 + packed_len))
    }
}

/// Кодирует последовательность `(контекст, символ)` одним rANS-потоком.
///
/// Возвращает байты в порядке чтения декодером: `[state LE][поток]`.
pub fn encode_symbols(tables: &[FreqTable], syms: &[(u8, u8)]) -> Vec<u8> {
    let mut state: u32 = RANS_L;
    let mut rev: Vec<u8> = Vec::new();
    for &(ctx, sym) in syms.iter().rev() {
        let t = &tables[usize::from(ctx)];
        let freq = t.f(sym);
        debug_assert!(freq > 0, "кодирование символа с нулевой частотой");
        let x_max = ((RANS_L >> PROB_BITS) << 8) * freq;
        while state >= x_max {
            rev.push((state & 0xFF) as u8);
            state >>= 8;
        }
        state = ((state / freq) << PROB_BITS) + (state % freq) + t.c(sym);
    }
    let mut out = Vec::with_capacity(4 + rev.len());
    out.extend_from_slice(&state.to_le_bytes());
    out.extend(rev.iter().rev());
    out
}

/// Потоковый rANS-декодер (читает байты вперёд).
pub struct RansDecoder<'a> {
    state: u32,
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> RansDecoder<'a> {
    pub fn new(bytes: &'a [u8]) -> Result<Self, DecodeError> {
        let Some(head) = bytes.get(..4) else {
            return Err(DecodeError::Corrupt("rans: секция короче 4 байт состояния"));
        };
        let state = u32::from_le_bytes(head.try_into().expect("len == 4"));
        if state < RANS_L {
            return Err(DecodeError::Corrupt("rans: начальное состояние вне диапазона"));
        }
        Ok(Self { state, bytes, pos: 4 })
    }

    /// Декодирует один символ в контексте `table`.
    pub fn get(&mut self, table: &FreqTable) -> Result<u8, DecodeError> {
        let slot = self.state & (PROB_SCALE - 1);
        let sym = table.lookup(slot);
        let freq = table.f(sym);
        let start = table.c(sym);
        // freq > 0 гарантировано: slot всегда попадает в непустой интервал cum.
        self.state = freq * (self.state >> PROB_BITS) + slot - start;
        while self.state < RANS_L {
            let Some(&b) = self.bytes.get(self.pos) else {
                return Err(DecodeError::Corrupt("rans: поток закончился до последнего символа"));
            };
            self.pos += 1;
            self.state = (self.state << 8) | u32::from(b);
        }
        Ok(sym)
    }

    /// Проверка корректного завершения: все байты съедены, состояние вернулось к L.
    pub fn finish(&self) -> Result<(), DecodeError> {
        if self.state != RANS_L {
            return Err(DecodeError::Corrupt("rans: некорректное финальное состояние"));
        }
        if self.pos != self.bytes.len() {
            return Err(DecodeError::Corrupt("rans: лишние байты в секции токенов"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xorshift(seed: &mut u64) -> u64 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        *seed
    }

    #[test]
    fn freq_table_roundtrip() {
        let mut hist = [0u32; ALPHABET];
        hist[3] = 100;
        hist[4] = 5;
        hist[9] = 1;
        let table = FreqTable::from_histogram(&hist);
        let mut buf = Vec::new();
        table.serialize(&mut buf);
        let (parsed, used) = FreqTable::deserialize(&buf).unwrap();
        assert_eq!(used, buf.len());
        assert_eq!(parsed.freq, table.freq);
    }

    #[test]
    fn rans_roundtrip_multi_context() {
        let mut seed = 0x1234_5678_9ABC_DEF0u64;
        let mut hists = [[0u32; ALPHABET]; 3];
        let mut syms: Vec<(u8, u8)> = Vec::new();
        for _ in 0..50_000 {
            let ctx = (xorshift(&mut seed) % 3) as u8;
            // Скошенное распределение: маленькие символы чаще.
            let r = xorshift(&mut seed) % 100;
            let sym = if r < 60 { 0 } else if r < 85 { (r % 4) as u8 } else { (r % 20) as u8 };
            hists[usize::from(ctx)][usize::from(sym)] += 1;
            syms.push((ctx, sym));
        }
        let tables: Vec<FreqTable> = hists.iter().map(FreqTable::from_histogram).collect();
        let encoded = encode_symbols(&tables, &syms);
        let mut dec = RansDecoder::new(&encoded).unwrap();
        for &(ctx, sym) in &syms {
            assert_eq!(dec.get(&tables[usize::from(ctx)]).unwrap(), sym);
        }
        dec.finish().unwrap();
    }

    #[test]
    fn empty_symbol_list() {
        let tables = [FreqTable::from_histogram(&[0u32; ALPHABET])];
        let encoded = encode_symbols(&tables, &[]);
        let dec = RansDecoder::new(&encoded).unwrap();
        dec.finish().unwrap();
    }
}
