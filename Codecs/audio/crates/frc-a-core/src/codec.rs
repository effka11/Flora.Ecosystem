//! Энкодер и декодер кадров FRC-A v0 (FRC-A.md, «Codec overview» и «Кадр (packet)»).

use core::f32::consts::FRAC_1_SQRT_2;

use crate::alloc::{Q_SILENCE_X4, compute_alloc, rice_k_for_beta};
use crate::bands::{NUM_BANDS, band_range};
use crate::bitio::{unzigzag, zigzag};
use crate::energy::{FINE_BITS, analyze_plane, dequant_gain, dequant_gain_fine};
use crate::error::Error;
use crate::qmath::{pow2_e8, pow2_e64};
use crate::rangecoder::{AdaptiveProb, BinDecoder, BinEncoder, Prob0, bit_cost_x64};
use crate::transform::{FRAME_N, FrameTransform, SHORT_BLOCKS};

const HEADER_BITS: u64 = 32;
/// Накладные расходы range coder'а: ведущий байт + 5 байтов финализации.
const RC_OVERHEAD_BITS: u64 = 48;
const LAMBDA_MAX: u32 = 127;
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

/// Эскейп бинаризации: после 24 «продолжающих» битов значение пишется как
/// 32 сырых бита (та же семантика, что у эскейпа Райса в v0.2).
const UNARY_CAP: u32 = 24;
const ESCAPE_RAW_BITS: u32 = 32;

/// Нормативные стартовые вероятности «бит = 0» (масштаб 4096) адаптивных
/// контекстов унарных префиксов; контексты сбрасываются на границе кадра.
/// Форма: P(continue) = 1761/4096 ≈ 0.43 — оптимум геометрического частного
/// со средним ~0.75; стоимость нуля < 1 бита сохраняет гарантию «форма
/// помещается в бюджет» (β ≥ 8 ⇒ бюджет нуля ≥ 1 бит на коэффициент), а
/// адаптация к потоку нулей только удешевляет их дальше.
const P0_SHAPE: Prob0 = 2335;
/// Энергии: дельты малы, частное при k=4 редко ≥ 1 → P(continue) = 1229/4096 ≈ 0.30.
const P0_ENERGY: Prob0 = 2867;
const COST_RAW_X64: u64 = 64;

/// Порог детектора транзиентов: скачок HF-энергии суб-блока относительно
/// максимума двух предыдущих (нормативен только флаг в битстриме, не детектор).
const TRANSIENT_RATIO: f32 = 8.0;
const TRANSIENT_FLOOR: f32 = 1e-7;
/// Ниже этого бюджета кадра транзиентный режим не используется: короткие кадры
/// не получают noise-fill, и при почти нулевой аллокации дали бы провалы звука.
const TRANSIENT_MIN_BUDGET: u16 = 512;

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
    /// Невозвращённый перерасход бюджета транзиентных кадров (VBR-lite), биты.
    debt: u64,
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
        })
    }

    /// Отключение детектора транзиентов (все кадры длинные) — для A/B-замеров
    /// и отладки; битстрим остаётся валидным.
    pub fn set_transient_detection(&mut self, enabled: bool) {
        self.transient_detection = enabled;
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

        // VBR-lite: транзиентный кадр получает +25% бюджета, долг гасится
        // следующими кадрами по base/8 — средний битрейт остаётся у цели.
        // Декодер не участвует: фактический бюджет всегда в заголовке кадра.
        let base = self.cfg.frame_budget_bits();
        let budget = if transient && self.debt <= u64::from(base) * 2 {
            let extra = u64::from(base) / 4;
            self.debt += extra;
            (u64::from(base) + extra).min(u64::from(u16::MAX)) as u16
        } else {
            let repay = self.debt.min(u64::from(base) / 8);
            self.debt -= repay;
            base - repay as u16
        };
        let energy_cost = energy_cost_x64(&q, planes);
        let shape_budget_x64 = (u64::from(budget) * 64)
            .saturating_sub((HEADER_BITS + RC_OVERHEAD_BITS) * 64 + energy_cost);
        // Аллокация получает бюджет за вычетом резерва fine-битов — вместе с
        // правилом «β ≥ 8» это гарантирует, что подходящий λ существует всегда.
        let alloc_budget = (shape_budget_x64 / 64).saturating_sub(fine_reserve_bits(planes));
        let beta = compute_alloc(&q, planes, alloc_budget);

        // λ: минимальный индекс (самый тонкий шаг), при котором форма помещается
        // в бюджет. Стоимость — детерминированная симуляция адаптивных контекстов
        // (без записи). Инвариант бисекции: возвращённый λ всегда укладывается
        // в бюджет; при λ = 127 все y = 0 и стоимость нуля < 1 бита < β/8·коэфф.
        let cost_for = |lambda: u32| -> u64 {
            let mut ctx = fresh_shape_ctx();
            let mut total = 0u64;
            for_each_coded_band(&beta, planes, lambda, |p, b, k, step| {
                total += u64::from(FINE_BITS) * COST_RAW_X64;
                let g = gains[p * NUM_BANDS + b];
                for &x in &coeffs[p * FRAME_N..][..FRAME_N][band_range(b)] {
                    total += val_cost_x64(zigzag(quantize(x, g, step)), k, &mut ctx[k as usize]);
                }
            });
            total
        };
        let lambda = if cost_for(LAMBDA_MAX) > shape_budget_x64 {
            LAMBDA_MAX
        } else {
            let (mut lo, mut hi) = (0u32, LAMBDA_MAX);
            while lo < hi {
                let mid = (lo + hi) / 2;
                if cost_for(mid) <= shape_budget_x64 {
                    hi = mid;
                } else {
                    lo = mid + 1;
                }
            }
            hi
        };

        let mut enc = BinEncoder::new();
        write_energies(&mut enc, &q, planes);
        let mut ctx = fresh_shape_ctx();
        // Попутно с записью выясняем, есть ли «слышимо схлопнувшиеся» блоки:
        // кодируемые полосы, где какой-то короткий блок ушёл в ноль при живой
        // энергии полосы — сейчас и в недавней истории.
        let (h1, h2) = (&self.q_hist1, &self.q_hist2);
        let mut collapse_audible = false;
        for_each_coded_band(&beta, planes, lambda, |p, b, k, step| {
            enc.encode_bits(u32::from(fine[p * NUM_BANDS + b]), FINE_BITS);
            let g = gains[p * NUM_BANDS + b];
            let mut block_nonzero = [false; SHORT_BLOCKS];
            for (i, &x) in coeffs[p * FRAME_N..][..FRAME_N][band_range(b)]
                .iter()
                .enumerate()
            {
                let y = quantize(x, g, step);
                if y != 0 {
                    block_nonzero[i % SHORT_BLOCKS] = true;
                }
                encode_val(&mut enc, zigzag(y), k, &mut ctx[k as usize]);
            }
            let idx = p * NUM_BANDS + b;
            let qmin = q[idx].min(h1[idx]).min(h2[idx]);
            if transient && qmin > Q_SILENCE_X4 && block_nonzero.iter().any(|&z| !z) {
                collapse_audible = true;
            }
        });
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
        out.push(lambda as u8);
        out.extend_from_slice(&budget.to_le_bytes());
        out.extend_from_slice(&enc.finish());
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
        if packet.len() < 4 {
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
        let lambda = u32::from(packet[1]);
        if lambda > LAMBDA_MAX {
            return Err(Error::InvalidPacket("lambda out of range"));
        }
        let budget = u16::from_le_bytes([packet[2], packet[3]]);

        let mut r = BinDecoder::new(&packet[4..]);
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
        let mut ctx = fresh_shape_ctx();
        let mut shape_cost = 0u64;
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
                    let k = rice_k_for_beta(be);
                    let step = pow2_e8(lambda as i32 - 32 - i32::from(be));
                    for v in dst.iter_mut() {
                        let u = decode_val(&mut r, k, &mut ctx[k as usize], &mut shape_cost);
                        *v = unzigzag(u) as f32 * step;
                    }
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
            self.apply_anti_collapse(&mut coeffs, &q, &beta, &band_gain, lambda as i32, planes);
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
        lambda: i32,
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
                // Кодируемая полоса: схлопнувшийся блок лежал ниже шага
                // квантования, поэтому шум ограничен полом квантования —
                // step/2 на коэффициент, √(W/8) коэффициентов в блоке.
                let r = if beta[idx] > 0 {
                    let step = pow2_e8(lambda - 32 - i32::from(beta[idx]));
                    let per_block = (range.len() / SHORT_BLOCKS) as f32;
                    r_hist.min(0.5 * step * per_block.sqrt())
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

/// Адаптивные контексты формы кадра: унарный префикс — свой контекст на каждое
/// значение k (статистики частного зависят от плотности аллокации).
type ShapeCtx = [AdaptiveProb; 8];

fn fresh_shape_ctx() -> ShapeCtx {
    [AdaptiveProb::new(P0_SHAPE); 8]
}

/// Бинаризация значения: унарный префикс частного `u >> k` с адаптивным
/// контекстом, стоп-бит, затем `k` сырых битов остатка. После `UNARY_CAP`
/// продолжений — эскейп: значение целиком как 32 сырых бита.
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

/// Обходит кодируемые полосы (β > 0) в нормативном порядке с их параметрами
/// бинаризации (k сырых битов) и шагом; общий код подсчёта стоимости и записи.
fn for_each_coded_band(
    beta: &[u8],
    planes: usize,
    lambda: u32,
    mut f: impl FnMut(usize, usize, u32, f32),
) {
    for p in 0..planes {
        for b in 0..NUM_BANDS {
            let be = beta[p * NUM_BANDS + b];
            if be == 0 {
                continue;
            }
            let k = rice_k_for_beta(be);
            let step = pow2_e8(lambda as i32 - 32 - i32::from(be));
            f(p, b, k, step);
        }
    }
}

fn quantize(x: f32, gain: f32, step: f32) -> i32 {
    (x / gain / step).round() as i32
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

    /// Гарантия «подходящий λ существует»: при λ = 127 форма — сплошные нули,
    /// контекст видит только стоп-биты, и цена нуля никогда не превышает
    /// стартовую, которая меньше 1 бита (< 64/64 при β ≥ 8 на коэффициент).
    #[test]
    fn zero_symbol_never_exceeds_one_bit() {
        let start = bit_cost_x64(P0_SHAPE, false);
        assert!(
            start < 64,
            "стартовая цена нуля {start}/64 должна быть < 1 бита"
        );
        let mut ctx = AdaptiveProb::new(P0_SHAPE);
        for i in 0..1000 {
            let cost = bit_cost_x64(ctx.prob0(), false);
            assert!(
                cost <= start,
                "шаг {i}: цена нуля выросла: {cost} > {start}"
            );
            ctx.update(false);
        }
    }

    /// Roundtrip бинаризации + сверка учёта: стоимость, накопленная декодером,
    /// обязана бит-в-бит совпасть с оценкой энкодера (симметрия rate-контроля).
    #[test]
    fn val_binarization_roundtrip_and_cost_symmetry() {
        let values = [0u32, 1, 2, 7, 8, 100, 1000, 65_535, u32::MAX];
        for k in 0..=7u32 {
            let mut enc = BinEncoder::new();
            let mut enc_ctx = AdaptiveProb::new(P0_SHAPE);
            let mut cost_ctx = AdaptiveProb::new(P0_SHAPE);
            let mut enc_cost = 0u64;
            for &v in &values {
                encode_val(&mut enc, v, k, &mut enc_ctx);
                enc_cost += val_cost_x64(v, k, &mut cost_ctx);
            }
            let bytes = enc.finish();
            // Фактический размер не превышает оценку + финализация (6 байт).
            assert!(
                bytes.len() as u64 * 8 * 64 <= enc_cost + 48 * 64,
                "k={k}: {} байт при оценке {enc_cost}/64 бита",
                bytes.len()
            );
            let mut dec = BinDecoder::new(&bytes);
            let mut dec_ctx = AdaptiveProb::new(P0_SHAPE);
            let mut dec_cost = 0u64;
            for &v in &values {
                assert_eq!(decode_val(&mut dec, k, &mut dec_ctx, &mut dec_cost), v);
            }
            assert!(!dec.overrun());
            assert_eq!(dec_cost, enc_cost, "k={k}: рассинхрон учёта стоимости");
        }
    }
}
