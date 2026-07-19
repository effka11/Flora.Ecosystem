//! Энкодер и декодер кадров FRC-A v0 (FRC-A.md, «Codec overview» и «Кадр (packet)»).

use core::f32::consts::FRAC_1_SQRT_2;

use crate::alloc::{BETA_E8_MAX, LOG2W_X4, Q_SILENCE_X4, compute_alloc};
use crate::bands::{NUM_BANDS, band_range, band_width};
use crate::bitio::{unzigzag, zigzag};
use crate::energy::{FINE_BITS, analyze_plane, dequant_gain, dequant_gain_fine};
use crate::error::Error;
use crate::pvq;
use crate::qmath::{pow2_e8, pow2_e64};
use crate::rangecoder::{AdaptiveProb, BinDecoder, BinEncoder, Prob0, bit_cost_x64};
use crate::transform::{FRAME_N, FrameTransform, SHORT_BLOCKS};

/// Заголовок кадра: flags (1 байт) + бюджет u16le.
const HEADER_BITS: u64 = 24;
/// Накладные расходы range coder'а: 5 байтов финализации (ведущий байт
/// классической схемы не передаётся).
const RC_OVERHEAD_BITS: u64 = 40;
const ENERGY_RAW_K: u32 = 4;
const ENERGY_Q_CLAMP: i32 = 1024;
const FLAG_TRANSIENT: u32 = 1 << 0;
const FLAG_ANTI_COLLAPSE: u32 = 1 << 1;
const FLAG_MS_STEREO: u32 = 1 << 3;
const PLC_DECAY: f32 = 0.7;

/// «Нет истории» для памяти энергий anti-collapse (ниже любого честного q).
const Q_HIST_INIT: i32 = -1024;
/// Затухание памяти энергий на PLC-кадр: −4 единицы q ≈ −3 дБ (соответствует
/// амплитудному затуханию PLC 0.7).
const Q_HIST_PLC_DECAY: i32 = 4;
/// Гейн шума anti-collapse: доля одного короткого блока от гейна полосы,
/// `2^(8·qmin/64) / √8` → показатель `8·qmin − 96` в 1/64 log2.
const AC_BLOCK_SHIFT_X64: i32 = 96;

/// Эскейп бинаризации энергий: после 24 «продолжающих» битов значение
/// пишется как 32 сырых бита.
const UNARY_CAP: u32 = 24;
const ESCAPE_RAW_BITS: u32 = 32;

/// Нормативная стартовая вероятность «бит = 0» (масштаб 4096) адаптивного
/// контекста унарных префиксов энергий; контекст сбрасывается на границе
/// кадра. Дельты малы, частное при k=4 редко ≥ 1 → P(continue) ≈ 0.30.
const P0_ENERGY: Prob0 = 2867;
const COST_RAW_X64: u64 = 64;

/// Порог детектора транзиентов: скачок HF-энергии суб-блока относительно
/// максимума двух предыдущих (нормативен только флаг в битстриме, не детектор).
const TRANSIENT_RATIO: f32 = 8.0;
const TRANSIENT_FLOOR: f32 = 1e-7;
/// Ниже этого бюджета кадра транзиентный режим не используется: короткие кадры
/// не получают noise-fill, и при почти нулевой аллокации дали бы провалы звука.
const TRANSIENT_MIN_BUDGET: u16 = 512;

/// VBR по сложности (ненормативно — поведение референсного энкодера).
/// Полезная потребность кадра: биты на полосы в пределах этого окна от
/// пиковой плотности энергии кадра (80 единиц по 0.75 дБ = 60 дБ — порядок
/// перцептивного динамического диапазона музыкального кадра); всё тише —
/// утечка окна и цифровой фон, их закрывает noise-fill.
const VBR_DYN_RANGE_X4: i32 = 80;
/// Кап буста тяжёлого кадра: +50% базового бюджета.
const VBR_BOOST_DIV: u16 = 2;
/// Кап пула сбережений VBR в базовых бюджетах кадра: ограничивает всплеск
/// после долгой тишины.
const VBR_POOL_CAP_FRAMES: u64 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Config {
    pub sample_rate: u32,
    pub channels: u8,
    pub bitrate_bps: u32,
}

impl Config {
    fn validate(&self) -> Result<(), Error> {
        validate_stream_params(self.sample_rate, self.channels)?;
        if !(8_000..=510_000).contains(&self.bitrate_bps) {
            return Err(Error::InvalidConfig("bitrate must be in 8..=510 kbps"));
        }
        Ok(())
    }

    /// Бюджет кадра в битах; передаётся в заголовке пакета (u16le).
    fn frame_budget_bits(&self) -> u16 {
        let rate = u64::from(self.sample_rate);
        let bits = (u64::from(self.bitrate_bps) * FRAME_N as u64 + rate / 2) / rate;
        bits.min(u64::from(u16::MAX)) as u16
    }
}

fn validate_stream_params(sample_rate: u32, channels: u8) -> Result<(), Error> {
    if !matches!(sample_rate, 44_100 | 48_000) {
        return Err(Error::InvalidConfig("sample_rate must be 44100 or 48000"));
    }
    if !matches!(channels, 1 | 2) {
        return Err(Error::InvalidConfig("channels must be 1 or 2"));
    }
    Ok(())
}

pub struct Encoder {
    cfg: Config,
    transform: FrameTransform,
    /// Хвост предыдущего hop'а по каналам (домен L/R), planar.
    prev: Vec<f32>,
    transient_detection: bool,
    /// Coarse-энергии двух предыдущих кадров (для решения по anti-collapse).
    q_hist1: Vec<i32>,
    q_hist2: Vec<i32>,
    /// Невозвращённый перерасход бюджета транзиентных кадров (заём атак), биты.
    debt: u64,
    /// VBR по сложности кадра (по умолчанию включён).
    vbr: bool,
    /// Пул сбережений VBR: точный баланс «цель − факт» в битах. Лёгкие кадры
    /// пополняют его, голодающие тратят; отрицателен только на величину
    /// транзиентного займа.
    pool: i64,
}

impl Encoder {
    pub fn new(cfg: Config) -> Result<Self, Error> {
        cfg.validate()?;
        let bands = usize::from(cfg.channels) * NUM_BANDS;
        Ok(Self {
            cfg,
            transform: FrameTransform::new(),
            prev: vec![0.0; usize::from(cfg.channels) * FRAME_N],
            transient_detection: true,
            q_hist1: vec![Q_HIST_INIT; bands],
            q_hist2: vec![Q_HIST_INIT; bands],
            debt: 0,
            vbr: true,
            pool: 0,
        })
    }

    /// Отключение детектора транзиентов (все кадры длинные) — для A/B-замеров
    /// и отладки; битстрим остаётся валидным.
    pub fn set_transient_detection(&mut self, enabled: bool) {
        self.transient_detection = enabled;
    }

    /// Отключение VBR по сложности (бюджет каждого кадра — базовый, плюс
    /// транзиентный заём) — для A/B-замеров и отладки; битстрим остаётся
    /// валидным: фактический бюджет всегда записан в заголовке кадра.
    pub fn set_vbr(&mut self, enabled: bool) {
        self.vbr = enabled;
    }

    /// Кодирует один hop из `FRAME_N * channels` interleaved-сэмплов.
    /// Первый пакет опирается на нулевую предысторию; в конце потока нужно
    /// закодировать один дополнительный нулевой hop (flush) — задержка `FRAME_N`.
    pub fn encode_frame(&mut self, pcm_interleaved: &[f32]) -> Result<Vec<u8>, Error> {
        let ch = usize::from(self.cfg.channels);
        if pcm_interleaved.len() != FRAME_N * ch {
            return Err(Error::InvalidInput("pcm length must be FRAME_N * channels"));
        }

        // [prev | cur] по каналам; для стерео каналы заменяются на M/S до MDCT
        // (линейное преобразование коммутирует с MDCT, во времени оно дешевле).
        let mut time = vec![0f32; ch * 2 * FRAME_N];
        for c in 0..ch {
            let buf = &mut time[c * 2 * FRAME_N..][..2 * FRAME_N];
            buf[..FRAME_N].copy_from_slice(&self.prev[c * FRAME_N..][..FRAME_N]);
            for (j, dst) in buf[FRAME_N..].iter_mut().enumerate() {
                *dst = pcm_interleaved[j * ch + c];
            }
        }
        for c in 0..ch {
            self.prev[c * FRAME_N..][..FRAME_N]
                .copy_from_slice(&time[c * 2 * FRAME_N + FRAME_N..][..FRAME_N]);
        }
        // Детектор — до M/S, на «сырых» каналах.
        let transient = self.transient_detection
            && self.cfg.frame_budget_bits() >= TRANSIENT_MIN_BUDGET
            && detect_transient(&time, ch);
        if ch == 2 {
            let (l, r) = time.split_at_mut(2 * FRAME_N);
            for (a, b) in l.iter_mut().zip(r.iter_mut()) {
                let m = (*a + *b) * FRAC_1_SQRT_2;
                let s = (*a - *b) * FRAC_1_SQRT_2;
                *a = m;
                *b = s;
            }
        }

        let planes = ch;
        let mut coeffs = vec![0f32; planes * FRAME_N];
        for p in 0..planes {
            self.transform.forward(
                transient,
                &time[p * 2 * FRAME_N..][..2 * FRAME_N],
                &mut coeffs[p * FRAME_N..][..FRAME_N],
            );
        }

        let mut q = vec![0i32; planes * NUM_BANDS];
        let mut fine = vec![0u8; planes * NUM_BANDS];
        let mut gains = vec![0f32; planes * NUM_BANDS];
        for p in 0..planes {
            analyze_plane(
                &coeffs[p * FRAME_N..][..FRAME_N],
                &mut q[p * NUM_BANDS..][..NUM_BANDS],
                &mut fine[p * NUM_BANDS..][..NUM_BANDS],
                &mut gains[p * NUM_BANDS..][..NUM_BANDS],
            );
        }

        // VBR (ненормативно — поведение референсного энкодера): бюджет кадра
        // складывается из трёх механизмов.
        //  1. Транзиентный заём: атака получает +25%, долг гасится следующими
        //     кадрами по base/8 (ограниченный овердрафт, как в v0.4).
        //  2. Лёгкий кадр (потребность ниже базового бюджета) ужимается до
        //     потребности — сэкономленные биты копятся в пуле сбережений.
        //  3. Тяжёлый кадр (потребность выше) докупает недостающее из пула,
        //     не больше base/2 за кадр.
        // Потребность — биты полос в окне динамического диапазона от пиковой
        // плотности энергии кадра (`vbr_demand_bits`). Пул — точный баланс
        // «цель − факт», поэтому средний битрейт не превышает целевой (плюс
        // ограниченный транзиентный овердрафт). Декодер не участвует:
        // фактический бюджет всегда в заголовке кадра.
        let base = self.cfg.frame_budget_bits();
        let budget0 = if transient && self.debt <= u64::from(base) * 2 {
            let extra = u64::from(base) / 4;
            self.debt += extra;
            (u64::from(base) + extra).min(u64::from(u16::MAX)) as u16
        } else {
            let repay = self.debt.min(u64::from(base) / 8);
            self.debt -= repay;
            base - repay as u16
        };

        let energy_cost = energy_cost_x64(&q, planes);
        let mut budget = budget0;
        if self.vbr {
            let demand = vbr_demand_bits(&q, planes, energy_cost);
            if demand > u64::from(budget0) {
                // Тяжёлый кадр: докупаем недостающее из пула сбережений.
                // Перерасход спишется с пула после кодирования (балансом
                // «цель − факт»), здесь только выбор размера буста.
                let want = (demand - u64::from(budget0)).min(u64::from(base / VBR_BOOST_DIV));
                let boost = (want as i64).min(self.pool.max(0)) as u16;
                budget = budget0.saturating_add(boost);
            } else if !transient {
                // Лёгкий кадр: ужимаем бюджет до потребности — сэкономленное
                // уйдёт в пул (транзиентные кадры не ужимаем: заём атаки
                // выдан осознанно).
                budget = demand.max(u64::from(base / 2)).min(u64::from(budget0)) as u16;
            }
        }
        // Аллокация формы: бюджет за вычетом заголовка, накладных RC, стоимости
        // энергий и резерва fine-битов. Rate-контроль PVQ точный и открытый:
        // стоимость книги известна до записи, неизрасходованный остаток полосы
        // переносится в следующую кодируемую полосу (carry) — итерации по шагу
        // квантования не нужны.
        let shape_budget_x64 = (u64::from(budget) * 64)
            .saturating_sub((HEADER_BITS + RC_OVERHEAD_BITS) * 64 + energy_cost);
        let alloc_budget = (shape_budget_x64 / 64).saturating_sub(fine_reserve_bits(planes));
        let beta = compute_alloc(&q, planes, alloc_budget);

        let mut enc = BinEncoder::new();
        write_energies(&mut enc, &q, planes);
        // Попутно с записью выясняем, есть ли «слышимо схлопнувшиеся» блоки:
        // кодируемые полосы, где какой-то короткий блок ушёл в ноль при живой
        // энергии полосы — сейчас и в недавней истории.
        let (h1, h2) = (&self.q_hist1, &self.q_hist2);
        let mut collapse_audible = false;
        let mut carry = 0u32;
        let mut recon = vec![0f32; FRAME_N];
        for p in 0..planes {
            for b in 0..NUM_BANDS {
                let idx = p * NUM_BANDS + b;
                let be = beta[idx];
                if be == 0 {
                    continue;
                }
                enc.encode_bits(u32::from(fine[idx]), FINE_BITS);
                let range = band_range(b);
                let avail = u32::from(be) * range.len() as u32 + carry;
                let x = &coeffs[p * FRAME_N..][..FRAME_N][range.clone()];
                let dst = &mut recon[..range.len()];
                let spent = pvq::encode_shape(&mut enc, x, dst, avail);
                debug_assert!(spent <= avail);
                carry = avail - spent;

                let mut block_nonzero = [false; SHORT_BLOCKS];
                for (i, &v) in dst.iter().enumerate() {
                    if v != 0.0 {
                        block_nonzero[i % SHORT_BLOCKS] = true;
                    }
                }
                let qmin = q[idx].min(h1[idx]).min(h2[idx]);
                if transient && qmin > Q_SILENCE_X4 && block_nonzero.iter().any(|&z| !z) {
                    collapse_audible = true;
                }
            }
        }
        // Некодируемые полосы транзиентного кадра зануляются целиком — они тоже
        // кандидаты на anti-collapse, если энергия жива сейчас и в истории.
        if transient && !collapse_audible {
            collapse_audible = (0..planes * NUM_BANDS)
                .any(|idx| beta[idx] == 0 && q[idx].min(h1[idx]).min(h2[idx]) > Q_SILENCE_X4);
        }

        std::mem::swap(&mut self.q_hist2, &mut self.q_hist1);
        self.q_hist1.copy_from_slice(&q);

        let mut flags = if ch == 2 { FLAG_MS_STEREO } else { 0 };
        if transient {
            flags |= FLAG_TRANSIENT;
            if collapse_audible {
                flags |= FLAG_ANTI_COLLAPSE;
            }
        }
        let mut out = Vec::with_capacity(usize::from(budget / 8) + 8);
        out.push(flags as u8);
        out.extend_from_slice(&budget.to_le_bytes());
        out.extend_from_slice(&enc.finish());
        // Пул VBR: сколько кадр реально недобрал до цели (или перебрал —
        // тогда вклад отрицательный). Кап ограничивает всплеск после тишины.
        self.pool = (self.pool + i64::from(base) - out.len() as i64 * 8)
            .min(i64::from(base) * VBR_POOL_CAP_FRAMES as i64);
        Ok(out)
    }
}

pub struct Decoder {
    channels: u8,
    transform: FrameTransform,
    /// Хвост overlap-add по каналам, planar.
    ola: Vec<f32>,
    /// Последний декодированный спектр по плоскостям (для PLC).
    last_coeffs: Vec<f32>,
    /// Режим последнего кадра — PLC синтезирует в том же режиме.
    last_transient: bool,
    /// Coarse-энергии двух предыдущих кадров (память anti-collapse).
    q_hist1: Vec<i32>,
    q_hist2: Vec<i32>,
    frame_index: u32,
}

impl Decoder {
    pub fn new(sample_rate: u32, channels: u8) -> Result<Self, Error> {
        validate_stream_params(sample_rate, channels)?;
        let ch = usize::from(channels);
        Ok(Self {
            channels,
            transform: FrameTransform::new(),
            ola: vec![0.0; ch * FRAME_N],
            last_coeffs: vec![0.0; ch * FRAME_N],
            last_transient: false,
            q_hist1: vec![Q_HIST_INIT; ch * NUM_BANDS],
            q_hist2: vec![Q_HIST_INIT; ch * NUM_BANDS],
            frame_index: 0,
        })
    }

    /// Декодирует пакет в `FRAME_N * channels` interleaved-сэмплов.
    /// На некорректном пакете возвращает ошибку, не меняя состояния декодера.
    pub fn decode_frame(&mut self, packet: &[u8]) -> Result<Vec<f32>, Error> {
        let ch = usize::from(self.channels);
        let planes = ch;
        if packet.len() < 3 {
            return Err(Error::Truncated);
        }

        let flags = u32::from(packet[0]);
        if flags & !(FLAG_MS_STEREO | FLAG_TRANSIENT | FLAG_ANTI_COLLAPSE) != 0 {
            return Err(Error::InvalidPacket("reserved flag bits set"));
        }
        if (flags & FLAG_MS_STEREO != 0) != (ch == 2) {
            return Err(Error::InvalidPacket("channel mode mismatch"));
        }
        let transient = flags & FLAG_TRANSIENT != 0;
        let anti_collapse = flags & FLAG_ANTI_COLLAPSE != 0;
        if anti_collapse && !transient {
            return Err(Error::InvalidPacket("anti-collapse flag on long frame"));
        }
        let budget = u16::from_le_bytes([packet[1], packet[2]]);

        let mut r = BinDecoder::new(&packet[3..]);
        // Стоимость энергий считается по фактически прочитанным символам — на
        // враждебном битстриме (с клампом q) она всё равно согласована с записью.
        let (q, energy_cost) = read_energies(&mut r, planes);
        let shape_budget_x64 = (u64::from(budget) * 64)
            .saturating_sub((HEADER_BITS + RC_OVERHEAD_BITS) * 64 + energy_cost);
        let alloc_budget = (shape_budget_x64 / 64).saturating_sub(fine_reserve_bits(planes));
        let beta = compute_alloc(&q, planes, alloc_budget);

        let mut coeffs = vec![0f32; planes * FRAME_N];
        // Декодированные fine-гейны кодируемых полос — цель перенормировки
        // после инъекции anti-collapse.
        let mut band_gain = vec![0f32; planes * NUM_BANDS];
        let mut carry = 0u32;
        for p in 0..planes {
            for b in 0..NUM_BANDS {
                let idx = p * NUM_BANDS + b;
                let range = band_range(b);
                let dst = &mut coeffs[p * FRAME_N + range.start..p * FRAME_N + range.end];
                let be = beta[idx];
                if be > 0 {
                    let fine = r.decode_bits(FINE_BITS) as u8;
                    let gain = dequant_gain_fine(q[idx], fine);
                    band_gain[idx] = gain;
                    let avail = u32::from(be) * range.len() as u32 + carry;
                    let spent = pvq::decode_shape(&mut r, dst, avail);
                    carry = avail - spent;
                    // Перенормировка формы к декодированному gain'у: энергия полосы
                    // восстанавливается точно в пределах шага квантования энергии.
                    let norm = shape_norm(dst);
                    if norm > 1e-12 {
                        let scale = gain / norm;
                        for v in dst.iter_mut() {
                            *v *= scale;
                        }
                        continue;
                    }
                }
                // В транзиентных кадрах noise-fill выключен: детерминированный шум
                // без временной огибающей размазался бы на все 8 блоков и вернул
                // pre-echo, ради устранения которого кадр и стал коротким.
                if !transient {
                    noise_fill(
                        dst,
                        self.frame_index,
                        p as u32,
                        b as u32,
                        dequant_gain(q[idx]),
                    );
                }
            }
        }
        // Усечённый пакет обнаруживается до мутации состояния декодера.
        if r.overrun() {
            return Err(Error::Truncated);
        }

        if anti_collapse {
            self.apply_anti_collapse(&mut coeffs, &q, &beta, &band_gain, planes);
        }
        for v in coeffs.iter_mut() {
            if !v.is_finite() {
                *v = 0.0;
            }
        }

        std::mem::swap(&mut self.q_hist2, &mut self.q_hist1);
        self.q_hist1.copy_from_slice(&q);
        self.last_coeffs.copy_from_slice(&coeffs);
        self.last_transient = transient;
        let out = self.synthesize(transient, &coeffs);
        self.frame_index = self.frame_index.wrapping_add(1);
        Ok(out)
    }

    /// Anti-collapse (только транзиентные кадры, по флагу битстрима): короткие
    /// блоки, схлопнувшиеся в ноль, заполняются детерминированным шумом на
    /// уровне минимальной энергии полосы за два предыдущих кадра (прошлое не
    /// может «подсветить» атаку назад во времени — pre-echo не возникает).
    /// Кодируемые полосы после инъекции перенормируются к своему fine-гейну;
    /// некодируемые остаются на уровне шумового пола без перенормировки.
    fn apply_anti_collapse(
        &self,
        coeffs: &mut [f32],
        q: &[i32],
        beta: &[u8],
        band_gain: &[f32],
        planes: usize,
    ) {
        for p in 0..planes {
            for b in 0..NUM_BANDS {
                let idx = p * NUM_BANDS + b;
                let qmin = q[idx].min(self.q_hist1[idx]).min(self.q_hist2[idx]);
                if qmin <= Q_SILENCE_X4 {
                    continue;
                }
                let range = band_range(b);
                let dst = &mut coeffs[p * FRAME_N + range.start..p * FRAME_N + range.end];
                let r_hist = pow2_e64(8 * qmin - AC_BLOCK_SHIFT_X64);
                // Кодируемая полоса: схлопнувшийся блок лежал ниже шумового
                // пола квантования PVQ (β/8 бит/коэфф ≈ 6·β/8 дБ SNR), поэтому
                // шум ограничен `ĝ_fine · 2^(−(β+12)/8)` — доля гейна полосы
                // на блок (√8 = 2^(12/8)) при данной плотности бит.
                let r = if beta[idx] > 0 {
                    r_hist.min(band_gain[idx] * pow2_e8(-(i32::from(beta[idx]) + 12)))
                } else {
                    r_hist
                };
                let mut injected = false;
                for j in 0..SHORT_BLOCKS {
                    let collapsed = dst.iter().skip(j).step_by(SHORT_BLOCKS).all(|&v| v == 0.0);
                    if collapsed {
                        inject_block_noise(dst, j, self.frame_index, p as u32, b as u32, r);
                        injected = true;
                    }
                }
                if injected && beta[idx] > 0 {
                    let norm = shape_norm(dst);
                    if norm > 1e-12 {
                        let scale = band_gain[idx] / norm;
                        for v in dst.iter_mut() {
                            *v *= scale;
                        }
                    }
                }
            }
        }
    }

    /// PLC: потерянный пакет — повтор последнего спектра с затуханием,
    /// в режиме последнего кадра. Память энергий anti-collapse затухает
    /// синхронно с амплитудным затуханием PLC.
    pub fn decode_lost(&mut self) -> Vec<f32> {
        for v in self.last_coeffs.iter_mut() {
            *v *= PLC_DECAY;
        }
        for h in self.q_hist1.iter_mut().chain(self.q_hist2.iter_mut()) {
            *h = (*h - Q_HIST_PLC_DECAY).max(Q_HIST_INIT);
        }
        let coeffs = self.last_coeffs.clone();
        let out = self.synthesize(self.last_transient, &coeffs);
        self.frame_index = self.frame_index.wrapping_add(1);
        out
    }

    fn synthesize(&mut self, transient: bool, plane_coeffs: &[f32]) -> Vec<f32> {
        let ch = usize::from(self.channels);
        let mut chan = plane_coeffs.to_vec();
        if ch == 2 {
            let (m, s) = chan.split_at_mut(FRAME_N);
            for (a, b) in m.iter_mut().zip(s.iter_mut()) {
                let l = (*a + *b) * FRAC_1_SQRT_2;
                let r = (*a - *b) * FRAC_1_SQRT_2;
                *a = l;
                *b = r;
            }
        }
        let mut out = vec![0f32; FRAME_N * ch];
        let mut synth = vec![0f32; 2 * FRAME_N];
        for c in 0..ch {
            self.transform
                .inverse(transient, &chan[c * FRAME_N..][..FRAME_N], &mut synth);
            let ola = &mut self.ola[c * FRAME_N..][..FRAME_N];
            for j in 0..FRAME_N {
                out[j * ch + c] = ola[j] + synth[j];
            }
            ola.copy_from_slice(&synth[FRAME_N..]);
        }
        out
    }
}

/// Бинаризация значения (дельты энергий): унарный префикс частного `u >> k`
/// с адаптивным контекстом, стоп-бит, затем `k` сырых битов остатка. После
/// `UNARY_CAP` продолжений — эскейп: значение целиком как 32 сырых бита.
fn encode_val(enc: &mut BinEncoder, u: u32, k: u32, ctx: &mut AdaptiveProb) {
    let qt = u >> k;
    if qt >= UNARY_CAP {
        for _ in 0..UNARY_CAP {
            enc.encode_bit_adaptive(ctx, true);
        }
        enc.encode_bits(u, ESCAPE_RAW_BITS);
    } else {
        for _ in 0..qt {
            enc.encode_bit_adaptive(ctx, true);
        }
        enc.encode_bit_adaptive(ctx, false);
        enc.encode_bits(u & ((1u32 << k) - 1), k);
    }
}

/// Декодирует значение, накапливая стоимость прочитанных битов (1/64 бита)
/// той же формулой, что и оценка энкодера, — включая эволюцию контекста.
fn decode_val(dec: &mut BinDecoder, k: u32, ctx: &mut AdaptiveProb, cost: &mut u64) -> u32 {
    let mut qt = 0u32;
    while dec.decode_bit_adaptive(ctx, cost) {
        qt += 1;
        if qt == UNARY_CAP {
            *cost += u64::from(ESCAPE_RAW_BITS) * COST_RAW_X64;
            return dec.decode_bits(ESCAPE_RAW_BITS);
        }
    }
    *cost += u64::from(k) * COST_RAW_X64;
    (qt << k) | dec.decode_bits(k)
}

/// Верхняя оценка стоимости `encode_val` в 1/64 бита с эволюцией контекста
/// (симуляция без записи; used by rate-контроль и учёт энергий).
fn val_cost_x64(u: u32, k: u32, ctx: &mut AdaptiveProb) -> u64 {
    let qt = u >> k;
    let mut cost = 0u64;
    if qt >= UNARY_CAP {
        for _ in 0..UNARY_CAP {
            cost += bit_cost_x64(ctx.prob0(), true);
            ctx.update(true);
        }
        cost + u64::from(ESCAPE_RAW_BITS) * COST_RAW_X64
    } else {
        for _ in 0..qt {
            cost += bit_cost_x64(ctx.prob0(), true);
            ctx.update(true);
        }
        cost += bit_cost_x64(ctx.prob0(), false);
        ctx.update(false);
        cost + u64::from(k) * COST_RAW_X64
    }
}

fn energy_cost_x64(q: &[i32], planes: usize) -> u64 {
    let mut ctx = AdaptiveProb::new(P0_ENERGY);
    let mut total = 0u64;
    for p in 0..planes {
        let mut prev = 0i32;
        for b in 0..NUM_BANDS {
            let v = q[p * NUM_BANDS + b];
            total += val_cost_x64(zigzag(v.wrapping_sub(prev)), ENERGY_RAW_K, &mut ctx);
            prev = v;
        }
    }
    total
}

fn write_energies(enc: &mut BinEncoder, q: &[i32], planes: usize) {
    let mut ctx = AdaptiveProb::new(P0_ENERGY);
    for p in 0..planes {
        let mut prev = 0i32;
        for b in 0..NUM_BANDS {
            let v = q[p * NUM_BANDS + b];
            encode_val(enc, zigzag(v.wrapping_sub(prev)), ENERGY_RAW_K, &mut ctx);
            prev = v;
        }
    }
}

/// Читает энергии и возвращает их вместе со стоимостью фактически прочитанных
/// символов (в 1/64 бита) — она обязана совпасть с оценкой энкодера.
fn read_energies(dec: &mut BinDecoder, planes: usize) -> (Vec<i32>, u64) {
    let mut ctx = AdaptiveProb::new(P0_ENERGY);
    let mut q = vec![0i32; planes * NUM_BANDS];
    let mut cost = 0u64;
    for p in 0..planes {
        let mut prev = 0i32;
        for b in 0..NUM_BANDS {
            let u = decode_val(dec, ENERGY_RAW_K, &mut ctx, &mut cost);
            let v = prev
                .wrapping_add(unzigzag(u))
                .clamp(-ENERGY_Q_CLAMP, ENERGY_Q_CLAMP);
            q[p * NUM_BANDS + b] = v;
            prev = v;
        }
    }
    (q, cost)
}

/// Детектор транзиентов (только энкодер; нормативен лишь флаг в битстриме).
/// Критерий: скачок энергии первой разности (подчёркивает ВЧ, где живут атаки,
/// и подавляет стационарный бас) в суб-блоке длиной N/8 относительно максимума
/// двух предыдущих суб-блоков. Анализ — текущий hop + хвост предыдущего.
fn detect_transient(time: &[f32], channels: usize) -> bool {
    const SUB: usize = FRAME_N / SHORT_BLOCKS;
    const HISTORY: usize = 2;
    let mut e = [0f32; HISTORY + SHORT_BLOCKS];
    let start = FRAME_N - HISTORY * SUB;
    for c in 0..channels {
        let buf = &time[c * 2 * FRAME_N..][..2 * FRAME_N];
        for (blk, eb) in e.iter_mut().enumerate() {
            let s = start + blk * SUB;
            let mut acc = 0f32;
            for i in s..s + SUB {
                let d = buf[i] - buf[i - 1];
                acc += d * d;
            }
            *eb += acc;
        }
    }
    (HISTORY..HISTORY + SHORT_BLOCKS).any(|j| {
        let past = e[j - 1].max(e[j - 2]);
        e[j] > TRANSIENT_FLOOR && e[j] > TRANSIENT_RATIO * past + TRANSIENT_FLOOR
    })
}

/// Резерв на fine-биты энергий: по FINE_BITS на каждую потенциально
/// кодируемую полосу кадра.
fn fine_reserve_bits(planes: usize) -> u64 {
    u64::from(FINE_BITS) * (planes * NUM_BANDS) as u64
}

/// Потребность кадра в битах (сигнал сложности VBR): water-filling до окна
/// `VBR_DYN_RANGE_X4` от пиковой плотности энергии кадра — сколько бит нужно,
/// чтобы прокодировать всё, что громче пика минус окно, — плюс фактическая
/// стоимость энергий и накладные расходы. Единицы согласованы с аллокацией:
/// 1 единица q (0.25 log2 энергии) = 1/8 бита на коэффициент. Идеализация
/// (энтропийный кодер может уложиться дешевле), поэтому значение служит
/// только сигналом сложности, а не точным размером пакета.
fn vbr_demand_bits(q: &[i32], planes: usize, energy_cost_x64: u64) -> u64 {
    let density = |i: usize| q[i] - LOG2W_X4[i % NUM_BANDS];
    let overhead =
        energy_cost_x64.div_ceil(64) + HEADER_BITS + RC_OVERHEAD_BITS + fine_reserve_bits(planes);
    let peak = (0..q.len())
        .filter(|&i| q[i] > Q_SILENCE_X4)
        .map(density)
        .max();
    let Some(peak) = peak else {
        return overhead; // цифровая тишина: только энергии и накладные
    };
    let floor = peak - VBR_DYN_RANGE_X4;
    let mut shape_e8 = 0u64;
    for (i, &qi) in q.iter().enumerate() {
        if qi <= Q_SILENCE_X4 {
            continue;
        }
        let want = (density(i) - floor).clamp(0, BETA_E8_MAX);
        // Правило аллокации «дешевле 1 бит/коэфф не кодируем» — та же граница.
        if want >= 8 {
            shape_e8 += want as u64 * band_width(i % NUM_BANDS) as u64;
        }
    }
    shape_e8 / 8 + overhead
}

fn shape_norm(v: &[f32]) -> f32 {
    v.iter()
        .map(|&x| f64::from(x) * f64::from(x))
        .sum::<f64>()
        .sqrt() as f32
}

/// Детерминированный noise-fill (FRC-A.md): xorshift32 от seed из номера кадра,
/// плоскости и полосы; вектор нормируется к декодированному gain'у.
fn noise_fill(dst: &mut [f32], frame_index: u32, plane: u32, band: u32, gain: f32) {
    let mut x = noise_seed(frame_index, plane, band, 0);
    for v in dst.iter_mut() {
        *v = noise_next(&mut x);
    }
    let norm = shape_norm(dst);
    if norm > 1e-12 {
        let scale = gain / norm;
        for v in dst.iter_mut() {
            *v *= scale;
        }
    } else {
        dst.fill(0.0);
    }
}

/// Шум anti-collapse в короткий блок `j` полосы (интерливинг-позиции
/// `j, j+8, …`), нормированный к гейну блока `r`.
fn inject_block_noise(dst: &mut [f32], j: usize, frame_index: u32, plane: u32, band: u32, r: f32) {
    let mut x = noise_seed(frame_index, plane, band, j as u32);
    let mut norm_sq = 0f64;
    for v in dst.iter_mut().skip(j).step_by(SHORT_BLOCKS) {
        let n = noise_next(&mut x);
        *v = n;
        norm_sq += f64::from(n) * f64::from(n);
    }
    let norm = norm_sq.sqrt() as f32;
    if norm > 1e-12 {
        let scale = r / norm;
        for v in dst.iter_mut().skip(j).step_by(SHORT_BLOCKS) {
            *v *= scale;
        }
    }
}

/// Seed шумовых заполнений: длинные кадры используют `block = 0` (noise-fill
/// целой полосы), anti-collapse — номер короткого блока. Контексты не
/// пересекаются: в транзиентных кадрах noise-fill полос выключен.
fn noise_seed(frame_index: u32, plane: u32, band: u32, block: u32) -> u32 {
    (frame_index.wrapping_mul(2_654_435_761)
        ^ plane.wrapping_mul(40_503)
        ^ band.wrapping_mul(9_973)
        ^ block.wrapping_mul(131_071))
        | 1
}

fn noise_next(x: &mut u32) -> f32 {
    *x ^= *x << 13;
    *x ^= *x >> 17;
    *x ^= *x << 5;
    (*x as f32 / 2f32.powi(31)) - 1.0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Roundtrip бинаризации + сверка учёта: стоимость, накопленная декодером,
    /// обязана бит-в-бит совпасть с оценкой энкодера (симметрия rate-контроля
    /// энергий — единственного адаптивно кодируемого слоя).
    #[test]
    fn val_binarization_roundtrip_and_cost_symmetry() {
        let values = [0u32, 1, 2, 7, 8, 100, 1000, 65_535, u32::MAX];
        for k in 0..=7u32 {
            let mut enc = BinEncoder::new();
            let mut enc_ctx = AdaptiveProb::new(P0_ENERGY);
            let mut cost_ctx = AdaptiveProb::new(P0_ENERGY);
            let mut enc_cost = 0u64;
            for &v in &values {
                encode_val(&mut enc, v, k, &mut enc_ctx);
                enc_cost += val_cost_x64(v, k, &mut cost_ctx);
            }
            let bytes = enc.finish();
            // Фактический размер не превышает оценку + финализация (5 байт).
            assert!(
                bytes.len() as u64 * 8 * 64 <= enc_cost + 40 * 64,
                "k={k}: {} байт при оценке {enc_cost}/64 бита",
                bytes.len()
            );
            let mut dec = BinDecoder::new(&bytes);
            let mut dec_ctx = AdaptiveProb::new(P0_ENERGY);
            let mut dec_cost = 0u64;
            for &v in &values {
                assert_eq!(decode_val(&mut dec, k, &mut dec_ctx, &mut dec_cost), v);
            }
            assert!(!dec.overrun());
            assert_eq!(dec_cost, enc_cost, "k={k}: рассинхрон учёта стоимости");
        }
    }
}
