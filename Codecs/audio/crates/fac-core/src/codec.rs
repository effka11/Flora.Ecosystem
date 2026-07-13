//! Энкодер и декодер кадров FAC v0 (FAC.md, «Codec overview» и «Кадр (packet)»).

use core::f32::consts::FRAC_1_SQRT_2;

use crate::alloc::{compute_alloc, rice_k_for_beta};
use crate::bands::{NUM_BANDS, band_range};
use crate::bitio::{BitReader, BitWriter, rice_len, unzigzag, zigzag};
use crate::energy::{analyze_plane, dequant_gain};
use crate::error::Error;
use crate::mdct::Mdct;
use crate::qmath::pow2_e8;

/// Шаг кадра в сэмплах (20 мс @ 48 кГц); окно MDCT — `2 * FRAME_N`.
pub const FRAME_N: usize = 960;

const HEADER_BITS: u64 = 32;
const LAMBDA_MAX: u32 = 127;
const ENERGY_RICE_K: u32 = 4;
const ENERGY_Q_CLAMP: i32 = 1024;
const FLAG_MS_STEREO: u32 = 1 << 3;
const PLC_DECAY: f32 = 0.7;

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
    mdct: Mdct,
    /// Хвост предыдущего hop'а по каналам (домен L/R), planar.
    prev: Vec<f32>,
}

impl Encoder {
    pub fn new(cfg: Config) -> Result<Self, Error> {
        cfg.validate()?;
        Ok(Self {
            cfg,
            mdct: Mdct::new(FRAME_N),
            prev: vec![0.0; usize::from(cfg.channels) * FRAME_N],
        })
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
            self.mdct.forward(
                &time[p * 2 * FRAME_N..][..2 * FRAME_N],
                &mut coeffs[p * FRAME_N..][..FRAME_N],
            );
        }

        let mut q = vec![0i32; planes * NUM_BANDS];
        let mut gains = vec![0f32; planes * NUM_BANDS];
        for p in 0..planes {
            analyze_plane(
                &coeffs[p * FRAME_N..][..FRAME_N],
                &mut q[p * NUM_BANDS..][..NUM_BANDS],
                &mut gains[p * NUM_BANDS..][..NUM_BANDS],
            );
        }

        let budget = self.cfg.frame_budget_bits();
        let energy_bits = energy_bit_cost(&q, planes);
        let shape_budget = u64::from(budget).saturating_sub(HEADER_BITS + energy_bits);
        let beta = compute_alloc(&q, planes, shape_budget);

        // λ: минимальный индекс (самый тонкий шаг), при котором форма помещается
        // в бюджет. Биты формы нестрого убывают по λ, поэтому бисекция точна.
        let bits_for = |lambda: u32| -> u64 {
            let mut total = 0u64;
            for_each_shape_symbol(&coeffs, &gains, &beta, planes, lambda, |sym, k| {
                total += rice_len(sym, k);
            });
            total
        };
        let lambda = if bits_for(LAMBDA_MAX) > shape_budget {
            LAMBDA_MAX
        } else {
            let (mut lo, mut hi) = (0u32, LAMBDA_MAX);
            while lo < hi {
                let mid = (lo + hi) / 2;
                if bits_for(mid) <= shape_budget {
                    hi = mid;
                } else {
                    lo = mid + 1;
                }
            }
            hi
        };

        let mut w = BitWriter::new();
        w.write_bits(if ch == 2 { FLAG_MS_STEREO } else { 0 }, 8);
        w.write_bits(lambda, 8);
        w.write_bits(u32::from(budget) & 0xFF, 8);
        w.write_bits(u32::from(budget) >> 8, 8);
        write_energies(&mut w, &q, planes);
        for_each_shape_symbol(&coeffs, &gains, &beta, planes, lambda, |sym, k| {
            w.write_rice(sym, k);
        });
        Ok(w.finish())
    }
}

pub struct Decoder {
    channels: u8,
    mdct: Mdct,
    /// Хвост overlap-add по каналам, planar.
    ola: Vec<f32>,
    /// Последний декодированный спектр по плоскостям (для PLC).
    last_coeffs: Vec<f32>,
    frame_index: u32,
}

impl Decoder {
    pub fn new(sample_rate: u32, channels: u8) -> Result<Self, Error> {
        validate_stream_params(sample_rate, channels)?;
        let ch = usize::from(channels);
        Ok(Self {
            channels,
            mdct: Mdct::new(FRAME_N),
            ola: vec![0.0; ch * FRAME_N],
            last_coeffs: vec![0.0; ch * FRAME_N],
            frame_index: 0,
        })
    }

    /// Декодирует пакет в `FRAME_N * channels` interleaved-сэмплов.
    /// На некорректном пакете возвращает ошибку, не меняя состояния декодера.
    pub fn decode_frame(&mut self, packet: &[u8]) -> Result<Vec<f32>, Error> {
        let ch = usize::from(self.channels);
        let planes = ch;
        let mut r = BitReader::new(packet);

        let flags = r.read_bits(8)?;
        if flags & !FLAG_MS_STEREO != 0 {
            return Err(Error::InvalidPacket("reserved flag bits set"));
        }
        if (flags & FLAG_MS_STEREO != 0) != (ch == 2) {
            return Err(Error::InvalidPacket("channel mode mismatch"));
        }
        let lambda = r.read_bits(8)?;
        if lambda > LAMBDA_MAX {
            return Err(Error::InvalidPacket("lambda out of range"));
        }
        let budget = r.read_bits(8)? | (r.read_bits(8)? << 8);

        let pos_energy = r.bit_pos();
        let mut q = vec![0i32; planes * NUM_BANDS];
        for p in 0..planes {
            let mut prev = 0i32;
            for b in 0..NUM_BANDS {
                let d = unzigzag(r.read_rice(ENERGY_RICE_K)?);
                let v = prev
                    .wrapping_add(d)
                    .clamp(-ENERGY_Q_CLAMP, ENERGY_Q_CLAMP);
                q[p * NUM_BANDS + b] = v;
                prev = v;
            }
        }
        let energy_bits = r.bit_pos() - pos_energy;
        let shape_budget = u64::from(budget).saturating_sub(HEADER_BITS + energy_bits);
        let beta = compute_alloc(&q, planes, shape_budget);

        let mut coeffs = vec![0f32; planes * FRAME_N];
        for p in 0..planes {
            for b in 0..NUM_BANDS {
                let idx = p * NUM_BANDS + b;
                let gain = dequant_gain(q[idx]);
                let range = band_range(b);
                let dst = &mut coeffs[p * FRAME_N + range.start..p * FRAME_N + range.end];
                let be = beta[idx];
                if be > 0 {
                    let k = rice_k_for_beta(be);
                    let step = pow2_e8(lambda as i32 - 32 - i32::from(be));
                    for v in dst.iter_mut() {
                        *v = unzigzag(r.read_rice(k)?) as f32 * step;
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
                noise_fill(dst, self.frame_index, p as u32, b as u32, gain);
            }
        }
        for v in coeffs.iter_mut() {
            if !v.is_finite() {
                *v = 0.0;
            }
        }

        self.last_coeffs.copy_from_slice(&coeffs);
        let out = self.synthesize(&coeffs);
        self.frame_index = self.frame_index.wrapping_add(1);
        Ok(out)
    }

    /// PLC: потерянный пакет — повтор последнего спектра с затуханием.
    pub fn decode_lost(&mut self) -> Vec<f32> {
        for v in self.last_coeffs.iter_mut() {
            *v *= PLC_DECAY;
        }
        let coeffs = self.last_coeffs.clone();
        let out = self.synthesize(&coeffs);
        self.frame_index = self.frame_index.wrapping_add(1);
        out
    }

    fn synthesize(&mut self, plane_coeffs: &[f32]) -> Vec<f32> {
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
            self.mdct
                .inverse(&chan[c * FRAME_N..][..FRAME_N], &mut synth);
            let ola = &mut self.ola[c * FRAME_N..][..FRAME_N];
            for j in 0..FRAME_N {
                out[j * ch + c] = ola[j] + synth[j];
            }
            ola.copy_from_slice(&synth[FRAME_N..]);
        }
        out
    }
}

fn energy_bit_cost(q: &[i32], planes: usize) -> u64 {
    let mut total = 0u64;
    for p in 0..planes {
        let mut prev = 0i32;
        for b in 0..NUM_BANDS {
            let v = q[p * NUM_BANDS + b];
            total += rice_len(zigzag(v.wrapping_sub(prev)), ENERGY_RICE_K);
            prev = v;
        }
    }
    total
}

fn write_energies(w: &mut BitWriter, q: &[i32], planes: usize) {
    for p in 0..planes {
        let mut prev = 0i32;
        for b in 0..NUM_BANDS {
            let v = q[p * NUM_BANDS + b];
            w.write_rice(zigzag(v.wrapping_sub(prev)), ENERGY_RICE_K);
            prev = v;
        }
    }
}

/// Обходит символы формы (zigzag-квантованные коэффициенты) в нормативном
/// порядке; общий код для подсчёта битов и фактической записи.
fn for_each_shape_symbol(
    coeffs: &[f32],
    gains: &[f32],
    beta: &[u8],
    planes: usize,
    lambda: u32,
    mut f: impl FnMut(u32, u32),
) {
    for p in 0..planes {
        for b in 0..NUM_BANDS {
            let be = beta[p * NUM_BANDS + b];
            if be == 0 {
                continue;
            }
            let k = rice_k_for_beta(be);
            let step = pow2_e8(lambda as i32 - 32 - i32::from(be));
            let g = gains[p * NUM_BANDS + b];
            for &x in &coeffs[p * FRAME_N..][..FRAME_N][band_range(b)] {
                let y = (x / g / step).round() as i32;
                f(zigzag(y), k);
            }
        }
    }
}

fn shape_norm(v: &[f32]) -> f32 {
    v.iter()
        .map(|&x| f64::from(x) * f64::from(x))
        .sum::<f64>()
        .sqrt() as f32
}

/// Детерминированный noise-fill (FAC.md): xorshift32 от seed из номера кадра,
/// плоскости и полосы; вектор нормируется к декодированному gain'у.
fn noise_fill(dst: &mut [f32], frame_index: u32, plane: u32, band: u32, gain: f32) {
    let mut x = (frame_index.wrapping_mul(2_654_435_761)
        ^ plane.wrapping_mul(40_503)
        ^ band.wrapping_mul(9_973))
        | 1;
    for v in dst.iter_mut() {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        *v = (x as f32 / 2f32.powi(31)) - 1.0;
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
