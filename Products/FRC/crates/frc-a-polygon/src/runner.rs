//! Раннер полигона: прогон кодека по (кейс × битрейт), сбор метрик и
//! статистики потока. Кодек-задержка (FRAME_N) компенсируется, как в CLI.

use std::time::Instant;

use frc_a_core::{Config, Decoder, Encoder, FRAME_N};
use serde::{Deserialize, Serialize};

use crate::corpus::CorpusItem;
use crate::metrics::{self, QualityReport};

/// Вариант энкодера (для A/B): нормативный битстрим не меняется.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct EncoderVariant {
    pub transients: bool,
    pub vbr: bool,
}

impl Default for EncoderVariant {
    fn default() -> Self {
        Self {
            transients: true,
            vbr: true,
        }
    }
}

impl EncoderVariant {
    pub fn label(&self) -> String {
        match (self.transients, self.vbr) {
            (true, true) => "default".into(),
            (false, true) => "no-transients".into(),
            (true, false) => "no-vbr".into(),
            (false, false) => "no-transients,no-vbr".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaseResult {
    pub item: String,
    pub class: String,
    pub sample_rate: u32,
    pub channels: u8,
    pub bitrate_kbps: u32,
    pub variant: EncoderVariant,
    /// Фактический битрейт payload'а, kbps.
    pub actual_kbps: f64,
    /// Доля транзиентных кадров.
    pub transient_share: f64,
    /// Средний размер пакета, биты.
    pub mean_packet_bits: f64,
    /// Максимальный размер пакета, биты.
    pub max_packet_bits: u64,
    pub quality: QualityReport,
    /// Скорость кодирования/декодирования, × реального времени.
    pub enc_rt_factor: f64,
    pub dec_rt_factor: f64,
}

/// Кодирует и декодирует кейс, возвращая декод, выровненный с эталоном.
pub fn transcode(
    item: &CorpusItem,
    bitrate_bps: u32,
    variant: EncoderVariant,
) -> (Vec<f32>, Vec<Vec<u8>>, f64, f64) {
    let ch = usize::from(item.channels);
    let cfg = Config {
        sample_rate: item.sample_rate,
        channels: item.channels,
        bitrate_bps,
    };
    let mut enc = Encoder::new(cfg).expect("валидная конфигурация полигона");
    enc.set_transient_detection(variant.transients);
    enc.set_vbr(variant.vbr);
    let total = item.pcm.len() / ch;
    let hops = total.div_ceil(FRAME_N);

    let t0 = Instant::now();
    let mut packets = Vec::with_capacity(hops + 1);
    for h in 0..=hops {
        let mut chunk = vec![0f32; FRAME_N * ch];
        if h < hops {
            let start = h * FRAME_N;
            let len = (total - start).min(FRAME_N);
            chunk[..len * ch].copy_from_slice(&item.pcm[start * ch..(start + len) * ch]);
        }
        packets.push(enc.encode_frame(&chunk).expect("кодирование полигона"));
    }
    let enc_secs = t0.elapsed().as_secs_f64();

    let mut dec = Decoder::new(item.sample_rate, item.channels).expect("валидный декодер");
    let t1 = Instant::now();
    let mut out = Vec::with_capacity((hops + 1) * FRAME_N * ch);
    for p in &packets {
        out.extend(dec.decode_frame(p).expect("декодирование полигона"));
    }
    let dec_secs = t1.elapsed().as_secs_f64();

    let aligned = out[FRAME_N * ch..][..item.pcm.len()].to_vec();
    (aligned, packets, enc_secs, dec_secs)
}

pub fn run_case(item: &CorpusItem, bitrate_kbps: u32, variant: EncoderVariant) -> CaseResult {
    let (decoded, packets, enc_secs, dec_secs) = transcode(item, bitrate_kbps * 1000, variant);
    let quality = metrics::evaluate(&item.pcm, &decoded, usize::from(item.channels));

    let audio_secs = item.pcm.len() as f64 / f64::from(item.channels) / f64::from(item.sample_rate);
    let payload_bits: u64 = packets.iter().map(|p| p.len() as u64 * 8).sum();
    let transient = packets
        .iter()
        .filter(|p| p.first().is_some_and(|b| b & 1 != 0))
        .count();
    CaseResult {
        item: item.name.to_string(),
        class: item.class.as_str().to_string(),
        sample_rate: item.sample_rate,
        channels: item.channels,
        bitrate_kbps,
        variant,
        actual_kbps: payload_bits as f64 / audio_secs / 1000.0,
        transient_share: transient as f64 / packets.len() as f64,
        mean_packet_bits: payload_bits as f64 / packets.len() as f64,
        max_packet_bits: packets
            .iter()
            .map(|p| p.len() as u64 * 8)
            .max()
            .unwrap_or(0),
        quality,
        enc_rt_factor: audio_secs / enc_secs.max(1e-9),
        dec_rt_factor: audio_secs / dec_secs.max(1e-9),
    }
}

/// Сетка битрейтов по умолчанию: у моно и стерео свои рабочие точки
/// (голос E2E и музыкальный транскод Flora).
pub fn default_bitrates(channels: u8) -> &'static [u32] {
    if channels == 1 {
        &[24, 48, 96]
    } else {
        &[48, 96, 160]
    }
}

/// Полный прогон: для каждого кейса — своя сетка (или переопределение).
pub fn run_grid(
    items: &[CorpusItem],
    bitrates_override: Option<&[u32]>,
    variant: EncoderVariant,
) -> Vec<CaseResult> {
    let mut out = Vec::new();
    for item in items {
        let rates = bitrates_override.unwrap_or_else(|| default_bitrates(item.channels));
        for &r in rates {
            out.push(run_case(item, r, variant));
        }
    }
    out
}
