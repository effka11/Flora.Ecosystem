//! Адаптивное энтропийное ядро линии v7 (FRC-I.md §11.3, этап v7.1).
//!
//! FIFO range coder (32-битный, перенос через cache/pending-FF, схема LZMA)
//! плюс адаптивные частотные модели: счётчики u16 с инкрементом и
//! периодическим полуделением. В отличие от rANS (§3.2, LIFO) порядок
//! декодирования совпадает с порядком кодирования, поэтому модель может
//! адаптироваться после каждого символа одинаково на обеих сторонах.
//!
//! Всё целочисленно и детерминировано (контракт §9/§11.3: никакого f32
//! в энтропии). Число байт на выходе кодера равно числу байт, потребляемых
//! декодером при той же последовательности операций: обрыв потока — `Corrupt`.

use crate::error::DecodeError;

/// Порог ренормализации: пока range < 2^24, вводим/выводим байты.
const TOP: u32 = 1 << 24;

/// Начальный range. Меньше 2^32 сознательно: интервальный инвариант
/// (`low + range <= range_начальный`) гарантирует `low < 0xFF000000`
/// к моменту первого `shift_low`, то есть первый байт потока эмитится
/// немедленно и равен 0 — перенос в него невозможен по построению.
const RANGE_INIT: u32 = 0xFF00_0000;

// --- кодер ---------------------------------------------------------------------

/// Range-кодер. Первый байт потока всегда 0 (лаг-байт cache),
/// финализация — 5 вызовов `shift_low` (хвост состояния).
pub struct RangeEncoder {
    low: u64,
    range: u32,
    cache: u8,
    pending_ff: u64,
    started: bool,
    out: Vec<u8>,
}

impl Default for RangeEncoder {
    fn default() -> Self {
        Self::new()
    }
}

impl RangeEncoder {
    pub fn new() -> Self {
        Self {
            low: 0,
            range: RANGE_INIT,
            cache: 0,
            pending_ff: 0,
            started: false,
            out: Vec::new(),
        }
    }

    /// Кодирует символ с кумулятивой `cum`, частотой `freq` и суммой `total`
    /// (инварианты модели: `0 < freq`, `cum + freq <= total <= 2^16`).
    pub fn encode(&mut self, cum: u32, freq: u32, total: u32) {
        debug_assert!(freq > 0 && cum + freq <= total && total <= 1 << 16);
        let r = self.range / total;
        self.low += u64::from(r) * u64::from(cum);
        self.range = r * freq;
        while self.range < TOP {
            self.shift_low();
            self.range <<= 8;
        }
    }

    fn shift_low(&mut self) {
        let carry = (self.low >> 32) as u8; // 0 или 1
        if self.low < 0xFF00_0000 || carry == 1 {
            debug_assert!(self.started || carry == 0, "перенос в лаг-байт");
            self.out.push(self.cache.wrapping_add(carry));
            self.started = true;
            while self.pending_ff > 0 {
                self.out.push(0xFFu8.wrapping_add(carry));
                self.pending_ff -= 1;
            }
            self.cache = (self.low >> 24) as u8;
        } else {
            debug_assert!(self.started, "первый shift_low обязан эмитить");
            self.pending_ff += 1;
        }
        self.low = (self.low << 8) & 0xFFFF_FFFF;
    }

    /// Финализирует поток и возвращает байты. Инвариант: длина выхода
    /// равна числу байт, которое потребит декодер той же последовательности
    /// символов (5 стартовых + по одному на каждую ренормализацию); после
    /// четырёх сдвигов `low == 0`, поэтому пятый всегда сбрасывает pending.
    pub fn finish(mut self) -> Vec<u8> {
        for _ in 0..5 {
            self.shift_low();
        }
        debug_assert_eq!(self.pending_ff, 0);
        self.out
    }
}

// --- декодер ---------------------------------------------------------------------

/// Декодер range-кодера; читает ровно столько байт, сколько вывел кодер.
pub struct RangeDecoder<'a> {
    code: u32,
    range: u32,
    /// range/total последнего `decode_freq` — нужен парному `decode_update`.
    r: u32,
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> RangeDecoder<'a> {
    pub fn new(bytes: &'a [u8]) -> Result<Self, DecodeError> {
        // Стартовый байт (всегда 0 по построению) + 4 байта состояния.
        let Some(head) = bytes.get(..5) else {
            return Err(DecodeError::Corrupt("arith: обрыв инициализации"));
        };
        if head[0] != 0 {
            return Err(DecodeError::Corrupt("arith: ненулевой стартовый байт"));
        }
        Ok(Self {
            code: u32::from_be_bytes(head[1..5].try_into().expect("len 4")),
            range: RANGE_INIT,
            r: 0,
            bytes,
            pos: 5,
        })
    }

    /// Возвращает «слот» в [0, total): кумулятивную позицию текущего символа.
    /// После выбора символа обязателен парный `decode_update`.
    pub fn decode_freq(&mut self, total: u32) -> u32 {
        debug_assert!(total > 0 && total <= 1 << 16);
        self.r = self.range / total;
        (self.code / self.r).min(total - 1)
    }

    /// Съедает символ с кумулятивой `cum` и частотой `freq` (из `decode_freq`).
    pub fn decode_update(&mut self, cum: u32, freq: u32) -> Result<(), DecodeError> {
        self.code -= self.r * cum;
        self.range = self.r * freq;
        while self.range < TOP {
            let Some(&b) = self.bytes.get(self.pos) else {
                return Err(DecodeError::Corrupt("arith: обрыв потока"));
            };
            self.pos += 1;
            self.code = (self.code << 8) | u32::from(b);
            self.range <<= 8;
        }
        Ok(())
    }

    /// Число потреблённых байт (для проверки точного схождения секции).
    pub fn consumed(&self) -> usize {
        self.pos
    }
}

// --- адаптивная модель -----------------------------------------------------------

/// Потолок суммы частот; при достижении счётчики полуделятся (с полом 1).
/// 2^13 < 2^16 — совместимо с точностью кодера.
const ADAPT_LIMIT: u32 = 1 << 13;

/// Вид prior'а / алфавита модели. Разные контексты имеют разный носитель:
/// SPLIT/EOB — 2 символа, MODE — 15, RUN — 22, прочие hybrid-uint — 32.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelKind {
    /// SPLIT_WHOLE / SPLIT_QUAD.
    Split,
    /// Конец AC-блока: 0 = продолжить, 1 = EOB.
    Eob,
    /// Intra/CfL-мода v7 0..14.
    Mode,
    /// Transform v7.4: DCT/ADST/identity.
    Tx,
    /// DC hybrid-uint.
    Dc,
    /// Run + EOB (sym 31).
    Run,
    /// Level mag−1.
    Level,
}

impl ModelKind {
    pub fn alphabet(self) -> usize {
        match self {
            Self::Split | Self::Eob => 2,
            Self::Mode => 15,
            Self::Tx => 4,
            // Максимальный run в 32×32 равен 1022: hybrid-uint token = 21.
            Self::Run => 22,
            Self::Dc | Self::Level => 32,
        }
    }
}

/// Адаптивная частотная модель. Старт — prior по `ModelKind`; обучение
/// на лету одинаково у кодера и декодера. Шаг затухает с числом обновлений.
#[derive(Clone)]
pub struct AdaptiveModel {
    freq: [u16; 32],
    /// Рабочий размер алфавита (2 / 4 / 15 / 22 / 32); хвост не используется.
    n: u8,
    total: u32,
    updates: u32,
}

impl Default for AdaptiveModel {
    fn default() -> Self {
        Self::new(ModelKind::Level)
    }
}

/// Затухающий шаг обучения: 256 → 128 → 64 → 32 по числу обновлений.
#[inline]
fn adapt_inc(updates: u32) -> u16 {
    match updates {
        0..=15 => 256,
        16..=63 => 128,
        64..=255 => 64,
        _ => 32,
    }
}

fn prior(kind: ModelKind) -> ([u16; 32], u8, u32) {
    let mut freq = [0u16; 32];
    let n = kind.alphabet();
    match kind {
        ModelKind::Split => {
            // Небольшой уклон к WHOLE (0) — гладкие зоны чаще.
            freq[0] = 3;
            freq[1] = 2;
        }
        ModelKind::Eob => {
            // До прогрева не предполагаем плотность AC: continue / EOB поровну.
            freq[0] = 1;
            freq[1] = 1;
        }
        ModelKind::Mode => {
            for f in &mut freq[..n] {
                *f = 1;
            }
        }
        ModelKind::Tx => {
            // DCT_DCT — сильный prior; альтернативы должны окупить сигнал.
            freq[..n].copy_from_slice(&[8, 2, 2, 1]);
        }
        ModelKind::Dc => {
            // DC: малые значения чаще, без отдельного EOB.
            for (s, f) in freq[..n].iter_mut().enumerate() {
                *f = (16 - (s as i32 / 2)).max(1) as u16;
            }
        }
        ModelKind::Run => {
            // Короткие run'ы самые частые; EOB вынесен в бинарную модель.
            for (s, f) in freq[..n].iter_mut().enumerate() {
                *f = match s {
                    0 => 32,
                    1 => 16,
                    2 => 8,
                    3..=7 => 4,
                    _ => 1,
                };
            }
        }
        ModelKind::Level => {
            // |level|−1: нули и единицы доминируют.
            for (s, f) in freq[..n].iter_mut().enumerate() {
                *f = match s {
                    0 => 32,
                    1 => 16,
                    2..=3 => 4,
                    _ => 1,
                };
            }
        }
    }
    let total: u32 = freq[..n].iter().map(|&f| u32::from(f)).sum();
    (freq, n as u8, total)
}

impl AdaptiveModel {
    pub fn new(kind: ModelKind) -> Self {
        let (freq, n, total) = prior(kind);
        Self {
            freq,
            n,
            total,
            updates: 0,
        }
    }

    fn adapt(&mut self, sym: usize) {
        let n = usize::from(self.n);
        let inc = adapt_inc(self.updates);
        self.updates = self.updates.saturating_add(1);
        self.freq[sym] += inc;
        self.total += u32::from(inc);
        if self.total >= ADAPT_LIMIT {
            let mut total = 0u32;
            for f in &mut self.freq[..n] {
                *f = (*f >> 1).max(1);
                total += u32::from(*f);
            }
            self.total = total;
        }
    }

    /// Кодирует символ и адаптирует модель.
    pub fn encode(&mut self, enc: &mut RangeEncoder, sym: u8) {
        let sym = usize::from(sym);
        let n = usize::from(self.n);
        debug_assert!(sym < n);
        let mut cum = 0u32;
        for &f in &self.freq[..sym] {
            cum += u32::from(f);
        }
        enc.encode(cum, u32::from(self.freq[sym]), self.total);
        self.adapt(sym);
    }

    /// Декодирует символ и адаптирует модель.
    pub fn decode(&mut self, dec: &mut RangeDecoder<'_>) -> Result<u8, DecodeError> {
        let n = usize::from(self.n);
        let slot = dec.decode_freq(self.total);
        let mut cum = 0u32;
        let mut sym = 0usize;
        loop {
            let f = u32::from(self.freq[sym]);
            if cum + f > slot {
                dec.decode_update(cum, f)?;
                break;
            }
            cum += f;
            sym += 1;
            debug_assert!(sym < n);
            let _ = n;
        }
        self.adapt(sym);
        Ok(sym as u8)
    }
}

// --- банк контекстных моделей ------------------------------------------------

/// Банк адаптивных моделей v7 с иерархическим прогревом. Контексты секции
/// группируются: `group(ctx)` отображает детальный контекст в родительский
/// (например, все run-контексты одной зоны → общий родитель). Родитель
/// обучается на каждом символе группы; детальная модель при первом
/// использовании копирует текущее состояние родителя — тёплый старт вместо
/// холодного prior. Таблицы в поток не пишутся вовсе; обе стороны
/// строят одинаковые модели детерминированно.
///
/// Число order-1 бакетов на контекст: предыдущий символ того же контекста,
/// огрублённый до 4 бакетов. Благодаря прогреву от родителя разбавление
/// статистики дёшево: новый бакет стартует не с prior, а с текущего
/// группового распределения.
const CTX_BUCKETS: usize = 4;

#[inline]
fn bucket(prev: u8) -> usize {
    // 0..7 → 0, 8..15 → 1, 16..23 → 2, 24..31 → 3
    (usize::from(prev) >> 3).min(CTX_BUCKETS - 1)
}

impl ModelBank {
    /// `group_of[ctx]` — родительская группа; `kind_of[ctx]` — вид prior/алфавита.
    /// Значения групп плотные (0..n_groups). У всех контекстов одной группы
    /// обязан быть одинаковый `ModelKind` (иначе прогрев копирует чужой алфавит).
    pub fn new(group_of: Vec<u8>, kind_of: Vec<ModelKind>) -> Self {
        debug_assert_eq!(group_of.len(), kind_of.len());
        let n_groups = group_of
            .iter()
            .copied()
            .max()
            .map_or(0, |m| usize::from(m) + 1);
        let mut parent_kinds = vec![ModelKind::Level; n_groups];
        for (ctx, &g) in group_of.iter().enumerate() {
            parent_kinds[usize::from(g)] = kind_of[ctx];
        }
        let models: Vec<AdaptiveModel> = kind_of
            .iter()
            .flat_map(|&k| std::iter::repeat_with(move || AdaptiveModel::new(k)).take(CTX_BUCKETS))
            .collect();
        Self {
            models,
            parents: parent_kinds.into_iter().map(AdaptiveModel::new).collect(),
            prev: vec![0; group_of.len()],
            kind_of,
            group_of,
        }
    }

    /// Слот детальной модели (контекст × order-1 бакет) с прогревом от
    /// родителя группы при первом использовании. Order-1 включается
    /// только для алфавитов ≥ 16 (run/level/dc); для SPLIT/TX/MODE/EOB бакет
    /// всегда 0 — иначе холодные модели размывают короткую статистику.
    #[inline]
    fn warm(&mut self, ctx: usize) -> (usize, usize) {
        let n = self.kind_of[ctx].alphabet();
        let b = if n >= 16 { bucket(self.prev[ctx]) } else { 0 };
        let slot = ctx * CTX_BUCKETS + b;
        let g = usize::from(self.group_of[ctx]);
        if self.models[slot].updates == 0 && self.parents[g].updates > 0 {
            self.models[slot] = self.parents[g].clone();
            // Прогретая копия продолжает раннюю фазу обучения, а не позднюю.
            self.models[slot].updates = 0;
        }
        (slot, g)
    }

    pub fn encode(&mut self, enc: &mut RangeEncoder, ctx: u8, sym: u8) {
        let ctx = usize::from(ctx);
        let (slot, g) = self.warm(ctx);
        self.models[slot].encode(enc, sym);
        self.parents[g].adapt(usize::from(sym));
        self.prev[ctx] = sym;
    }

    pub fn decode(&mut self, dec: &mut RangeDecoder<'_>, ctx: u8) -> Result<u8, DecodeError> {
        let ctx = usize::from(ctx);
        let (slot, g) = self.warm(ctx);
        let sym = self.models[slot].decode(dec)?;
        self.parents[g].adapt(usize::from(sym));
        self.prev[ctx] = sym;
        Ok(sym)
    }
}

pub struct ModelBank {
    models: Vec<AdaptiveModel>,
    parents: Vec<AdaptiveModel>,
    /// Последний символ каждого контекста (селектор order-1 бакета).
    prev: Vec<u8>,
    #[allow(dead_code)]
    kind_of: Vec<ModelKind>,
    /// Родитель каждого контекста (индекс в `parents`).
    group_of: Vec<u8>,
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

    fn roundtrip(symbols: &[(u8, u8)], n_models: usize) {
        let mut models: Vec<AdaptiveModel> = (0..n_models)
            .map(|_| AdaptiveModel::new(ModelKind::Level))
            .collect();
        let mut enc = RangeEncoder::new();
        for &(ctx, sym) in symbols {
            models[usize::from(ctx)].encode(&mut enc, sym);
        }
        let bytes = enc.finish();

        let mut models: Vec<AdaptiveModel> = (0..n_models)
            .map(|_| AdaptiveModel::new(ModelKind::Level))
            .collect();
        let mut dec = RangeDecoder::new(&bytes).unwrap();
        for &(ctx, want) in symbols {
            let got = models[usize::from(ctx)].decode(&mut dec).unwrap();
            assert_eq!(got, want);
        }
        assert_eq!(dec.consumed(), bytes.len(), "поток потреблён не полностью");
    }

    #[test]
    fn empty_stream_roundtrips() {
        roundtrip(&[], 1);
    }

    #[test]
    fn random_symbols_roundtrip() {
        let mut seed = 0xF10A_2026u64;
        let symbols: Vec<(u8, u8)> = (0..50_000)
            .map(|_| {
                let ctx = (xorshift(&mut seed) % 8) as u8;
                let sym = (xorshift(&mut seed) % 32) as u8;
                (ctx, sym)
            })
            .collect();
        roundtrip(&symbols, 8);
    }

    #[test]
    fn skewed_symbols_compress_below_uniform() {
        // Сильно смещённое распределение: адаптация должна дать < 5 бит/симв.
        let mut seed = 0xBEEFu64;
        let symbols: Vec<(u8, u8)> = (0..100_000)
            .map(|_| {
                let r = xorshift(&mut seed) % 100;
                let sym = if r < 80 {
                    0
                } else if r < 95 {
                    1
                } else {
                    (xorshift(&mut seed) % 32) as u8
                };
                (0u8, sym)
            })
            .collect();
        let mut model = AdaptiveModel::new(ModelKind::Level);
        let mut enc = RangeEncoder::new();
        for &(_, sym) in &symbols {
            model.encode(&mut enc, sym);
        }
        let bytes = enc.finish();
        let bits_per_sym = bytes.len() as f64 * 8.0 / symbols.len() as f64;
        assert!(
            bits_per_sym < 1.5,
            "адаптация не работает: {bits_per_sym:.2} бит/симв"
        );
        roundtrip(&symbols, 1);
    }

    #[test]
    fn nonstationary_source_adapts() {
        // Первая половина — символ 3, вторая — символ 27: адаптивная модель
        // обязана перестроиться и остаться компактной.
        let symbols: Vec<(u8, u8)> = (0..20_000)
            .map(|i| (0u8, if i < 10_000 { 3u8 } else { 27u8 }))
            .collect();
        let mut model = AdaptiveModel::new(ModelKind::Level);
        let mut enc = RangeEncoder::new();
        for &(_, sym) in &symbols {
            model.encode(&mut enc, sym);
        }
        let bytes = enc.finish();
        assert!(
            bytes.len() < 2500,
            "нестационарный источник: {} байт",
            bytes.len()
        );
        roundtrip(&symbols, 1);
    }

    #[test]
    fn truncated_stream_is_corrupt_not_panic() {
        let symbols: Vec<(u8, u8)> = (0..5000).map(|i| (0u8, (i % 32) as u8)).collect();
        let mut model = AdaptiveModel::new(ModelKind::Level);
        let mut enc = RangeEncoder::new();
        for &(_, sym) in &symbols {
            model.encode(&mut enc, sym);
        }
        let bytes = enc.finish();
        for cut in 0..bytes.len().min(64) {
            let mut model = AdaptiveModel::new(ModelKind::Level);
            let Ok(mut dec) = RangeDecoder::new(&bytes[..cut]) else {
                continue; // < 5 байт — Corrupt на инициализации, тоже ок
            };
            // Либо дойдёт до обрыва (Err), либо раздекодирует мусор — но без паник.
            for _ in 0..symbols.len() {
                if model.decode(&mut dec).is_err() {
                    break;
                }
            }
        }
    }

    #[test]
    fn garbage_bytes_never_panic() {
        let mut seed = 0xDEAD_BEEFu64;
        for len in [0usize, 1, 5, 6, 64, 1000] {
            for _ in 0..50 {
                let mut bytes: Vec<u8> = (0..len)
                    .map(|_| (xorshift(&mut seed) & 0xFF) as u8)
                    .collect();
                if !bytes.is_empty() {
                    bytes[0] = 0; // валидный стартовый байт, остальное — мусор
                }
                let Ok(mut dec) = RangeDecoder::new(&bytes) else {
                    continue;
                };
                let mut model = AdaptiveModel::new(ModelKind::Level);
                for _ in 0..10_000 {
                    if model.decode(&mut dec).is_err() {
                        break;
                    }
                }
            }
        }
    }

    #[test]
    fn split_alphabet_rejects_out_of_range_in_debug() {
        let mut model = AdaptiveModel::new(ModelKind::Split);
        let mut enc = RangeEncoder::new();
        model.encode(&mut enc, 0);
        model.encode(&mut enc, 1);
        let bytes = enc.finish();
        let mut model = AdaptiveModel::new(ModelKind::Split);
        let mut dec = RangeDecoder::new(&bytes).unwrap();
        assert_eq!(model.decode(&mut dec).unwrap(), 0);
        assert_eq!(model.decode(&mut dec).unwrap(), 1);
        assert_eq!(dec.consumed(), bytes.len());
    }

    #[test]
    fn v7_syntax_uses_narrow_alphabets() {
        assert_eq!(ModelKind::Eob.alphabet(), 2);
        assert_eq!(ModelKind::Mode.alphabet(), 15);
        assert_eq!(ModelKind::Tx.alphabet(), 4);
        assert_eq!(ModelKind::Run.alphabet(), 22);

        let mut eob = AdaptiveModel::new(ModelKind::Eob);
        let mut run = AdaptiveModel::new(ModelKind::Run);
        let mut enc = RangeEncoder::new();
        for &(end, run_sym) in &[(0, 0), (0, 7), (0, 21), (1, 0)] {
            eob.encode(&mut enc, end);
            if end == 0 {
                run.encode(&mut enc, run_sym);
            }
        }
        let bytes = enc.finish();

        let mut eob = AdaptiveModel::new(ModelKind::Eob);
        let mut run = AdaptiveModel::new(ModelKind::Run);
        let mut dec = RangeDecoder::new(&bytes).unwrap();
        for &(want_end, want_run) in &[(0, 0), (0, 7), (0, 21), (1, 0)] {
            let end = eob.decode(&mut dec).unwrap();
            assert_eq!(end, want_end);
            if end == 0 {
                assert_eq!(run.decode(&mut dec).unwrap(), want_run);
            }
        }
        assert_eq!(dec.consumed(), bytes.len());
    }
}
