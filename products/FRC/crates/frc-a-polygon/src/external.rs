//! Внешние кодеки-конкуренты арены: Opus, AAC, MP3, Vorbis через `ffmpeg` /
//! `ffprobe` (CLI). Полигон — инструмент разработки; ядро (`frc-a-core`) от
//! ffmpeg не зависит, наличие ffmpeg на машине опционально (probe в рантайме).
//!
//! Честность сравнения:
//! - вход и выход — сырой f32le PCM (без промежуточного квантования в 16 бит);
//! - битрейт конкурента — сумма размеров **пакетов** кодека
//!   (`ffprobe -show_entries packet=size`), контейнерный оверхед Ogg/MP4/MP3
//!   не считается — так же, как у FRC-A считается чистый payload;
//! - задержка кодека компенсируется кросс-корреляцией (грубый поиск по
//!   энергетическим огибающим, затем точный по волне), декод обрезается или
//!   дополняется нулями до длины эталона;
//! - настройки конкурентов — дефолты ffmpeg с явной целью битрейта (`-b:a`);
//!   Opus дополнительно `-frame_duration 20` (тот же кадр 20 мс, что у FRC-A)
//!   и `-vbr constrained`: свободный VBR Opus превышает цель на десятки
//!   процентов (замер: ×1.23), ломая ось битрейта, тогда как VBR FRC-A
//!   ограничен +5% — constrained сопоставим по дисциплине. Конкуренты не
//!   тюнингуются под наши метрики; фактический битрейт каждой точки виден
//!   в таблице, систематические отклонения флагуются в сводке арены.
//!
//! Замер enc/dec-времени внешних кодеков включает запуск процесса ffmpeg —
//! ×RT конкурентов пригоден только для грубой ориентировки.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use crate::corpus::CorpusItem;

/// Максимальная компенсируемая задержка, сэмплы (±170 мс @ 48 кГц —
/// с многократным запасом против задержек Opus/AAC/MP3).
const MAX_LAG: i64 = 8192;
/// Размер блока энергетической огибающей грубого поиска.
const ENV_BLOCK: usize = 32;
/// Кап окна точного поиска, сэмплы (защита от квадратичного роста).
const FINE_WINDOW_CAP: usize = 262_144;

/// Кодек-конкурент, доступный через ffmpeg.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtCodec {
    Opus,
    Aac,
    Mp3,
    Vorbis,
}

impl ExtCodec {
    pub const ALL: [ExtCodec; 4] = [
        ExtCodec::Opus,
        ExtCodec::Aac,
        ExtCodec::Mp3,
        ExtCodec::Vorbis,
    ];

    pub fn id(self) -> &'static str {
        match self {
            ExtCodec::Opus => "opus",
            ExtCodec::Aac => "aac",
            ExtCodec::Mp3 => "mp3",
            ExtCodec::Vorbis => "vorbis",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "opus" => Some(ExtCodec::Opus),
            "aac" => Some(ExtCodec::Aac),
            "mp3" => Some(ExtCodec::Mp3),
            "vorbis" => Some(ExtCodec::Vorbis),
            _ => None,
        }
    }

    /// Имя энкодера ffmpeg (проверяется по списку `-encoders`).
    fn encoder_name(self) -> &'static str {
        match self {
            ExtCodec::Opus => "libopus",
            ExtCodec::Aac => "aac",
            ExtCodec::Mp3 => "libmp3lame",
            ExtCodec::Vorbis => "libvorbis",
        }
    }

    /// Расширение контейнера (Opus/Vorbis — Ogg, AAC — MP4, MP3 — свой).
    fn container_ext(self) -> &'static str {
        match self {
            ExtCodec::Opus | ExtCodec::Vorbis => "ogg",
            ExtCodec::Aac => "m4a",
            ExtCodec::Mp3 => "mp3",
        }
    }

    /// Аргументы кодирования ffmpeg (после `-i`).
    fn encode_args(self, bitrate_kbps: u32) -> Vec<String> {
        let b = format!("{bitrate_kbps}k");
        let mut args: Vec<String> = vec!["-c:a".into(), self.encoder_name().into()];
        args.push("-b:a".into());
        args.push(b);
        if self == ExtCodec::Opus {
            // Кадр 20 мс — та же гранулярность, что у FRC-A; constrained VBR —
            // сопоставимая с FRC-A дисциплина битрейта (см. заголовок модуля).
            args.extend(["-frame_duration".into(), "20".into()]);
            args.extend(["-application".into(), "audio".into()]);
            args.extend(["-vbr".into(), "constrained".into()]);
        }
        args
    }
}

/// Обнаруженный ffmpeg: версия и множество доступных аудио-энкодеров.
pub struct Ffmpeg {
    pub version: String,
    pub encoders: BTreeSet<String>,
}

/// Пробинг ffmpeg + ffprobe (кэшируется на процесс). `None` — арена недоступна.
pub fn info() -> Option<&'static Ffmpeg> {
    static INFO: OnceLock<Option<Ffmpeg>> = OnceLock::new();
    INFO.get_or_init(probe).as_ref()
}

fn probe() -> Option<Ffmpeg> {
    let version_out = Command::new("ffmpeg").arg("-version").output().ok()?;
    if !version_out.status.success() {
        return None;
    }
    // ffprobe обязателен: им считается payload-точный битрейт.
    let probe_out = Command::new("ffprobe").arg("-version").output().ok()?;
    if !probe_out.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&version_out.stdout)
        .lines()
        .next()
        .unwrap_or("ffmpeg (версия неизвестна)")
        .to_string();

    let enc_out = Command::new("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .output()
        .ok()?;
    let mut encoders = BTreeSet::new();
    for line in String::from_utf8_lossy(&enc_out.stdout).lines() {
        let mut parts = line.split_whitespace();
        let (Some(flags), Some(name)) = (parts.next(), parts.next()) else {
            continue;
        };
        if flags.starts_with('A') {
            encoders.insert(name.to_string());
        }
    }
    Some(Ffmpeg { version, encoders })
}

/// Конкуренты, реально доступные в этой сборке ffmpeg.
pub fn available() -> Vec<ExtCodec> {
    match info() {
        None => Vec::new(),
        Some(ff) => ExtCodec::ALL
            .into_iter()
            .filter(|c| ff.encoders.contains(c.encoder_name()))
            .collect(),
    }
}

/// Результат внешнего транскода, выровненный с эталоном.
pub struct ExtResult {
    /// Декод длины эталона (interleaved), задержка скомпенсирована.
    pub aligned: Vec<f32>,
    /// Размеры пакетов кодека, биты (по ffprobe).
    pub packet_bits: Vec<u64>,
    pub enc_secs: f64,
    pub dec_secs: f64,
    /// Найденный сдвиг декода, сэмплы (для диагностики).
    pub lag: i64,
}

/// Файлы транскода удаляются даже при ранних выходах по ошибке.
struct TempCleanup(Vec<PathBuf>);

impl Drop for TempCleanup {
    fn drop(&mut self) {
        for p in &self.0 {
            let _ = std::fs::remove_file(p);
        }
    }
}

fn run_tool(cmd: &mut Command, what: &str) -> Result<Vec<u8>, String> {
    let out = cmd
        .output()
        .map_err(|e| format!("{what}: запуск не удался: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let short: String = err.chars().take(300).collect();
        return Err(format!("{what}: {} — {}", out.status, short.trim()));
    }
    Ok(out.stdout)
}

/// Кодирует и декодирует кейс внешним кодеком; декод выровнен с эталоном.
pub fn transcode(
    item: &CorpusItem,
    bitrate_kbps: u32,
    codec: ExtCodec,
) -> Result<ExtResult, String> {
    let ff = info().ok_or_else(|| "ffmpeg/ffprobe не найдены в PATH".to_string())?;
    if !ff.encoders.contains(codec.encoder_name()) {
        return Err(format!(
            "в ffmpeg нет энкодера {} (кодек {})",
            codec.encoder_name(),
            codec.id()
        ));
    }

    static SEQ: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join("frc-a-polygon");
    std::fs::create_dir_all(&dir).map_err(|e| format!("временный каталог: {e}"))?;
    let tag = format!(
        "{}-{}-{}-{}k-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed),
        item.name,
        bitrate_kbps,
        codec.id()
    );
    let in_path = dir.join(format!("{tag}.in.raw"));
    let enc_path = dir.join(format!("{tag}.enc.{}", codec.container_ext()));
    let out_path = dir.join(format!("{tag}.out.raw"));
    let _cleanup = TempCleanup(vec![in_path.clone(), enc_path.clone(), out_path.clone()]);

    let mut in_bytes = Vec::with_capacity(item.pcm.len() * 4);
    for &s in &item.pcm {
        in_bytes.extend_from_slice(&s.to_le_bytes());
    }
    std::fs::write(&in_path, in_bytes).map_err(|e| format!("запись PCM: {e}"))?;

    let rate = item.sample_rate.to_string();
    let ch = item.channels.to_string();

    // Кодирование.
    let t0 = Instant::now();
    let mut enc = Command::new("ffmpeg");
    enc.args(["-hide_banner", "-v", "error", "-y", "-f", "f32le"])
        .args(["-ar", &rate, "-ac", &ch, "-i"])
        .arg(&in_path)
        .args(codec.encode_args(bitrate_kbps))
        .arg(&enc_path);
    run_tool(&mut enc, &format!("кодирование {}", codec.id()))?;
    let enc_secs = t0.elapsed().as_secs_f64();

    // Payload-точный битрейт: размеры пакетов кодека без контейнера.
    let mut probe_cmd = Command::new("ffprobe");
    probe_cmd
        .args(["-v", "error", "-select_streams", "a:0"])
        .args(["-show_entries", "packet=size", "-of", "csv=p=0"])
        .arg(&enc_path);
    let probe_out = run_tool(&mut probe_cmd, "ffprobe пакетов")?;
    let mut packet_bits = Vec::new();
    for line in String::from_utf8_lossy(&probe_out).lines() {
        let line = line.trim().trim_end_matches(',');
        if line.is_empty() {
            continue;
        }
        let bytes: u64 = line
            .parse()
            .map_err(|e| format!("ffprobe: размер пакета «{line}»: {e}"))?;
        packet_bits.push(bytes * 8);
    }
    if packet_bits.is_empty() {
        return Err("ffprobe не вернул ни одного пакета".to_string());
    }

    // Декодирование обратно в сырой f32 той же геометрии (rate/каналы эталона).
    let t1 = Instant::now();
    let mut dec = Command::new("ffmpeg");
    dec.args(["-hide_banner", "-v", "error", "-y", "-i"])
        .arg(&enc_path)
        .args(["-f", "f32le", "-ar", &rate, "-ac", &ch])
        .arg(&out_path);
    run_tool(&mut dec, &format!("декодирование {}", codec.id()))?;
    let dec_secs = t1.elapsed().as_secs_f64();

    let out_bytes = std::fs::read(&out_path).map_err(|e| format!("чтение декода: {e}"))?;
    let mut decoded = Vec::with_capacity(out_bytes.len() / 4);
    for chunk in out_bytes.chunks_exact(4) {
        let v = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        decoded.push(if v.is_finite() { v } else { 0.0 });
    }
    if decoded.is_empty() {
        return Err("пустой декод".to_string());
    }

    let ch_n = usize::from(item.channels);
    let lag = find_lag(&item.pcm, &decoded, ch_n);
    let aligned = apply_lag(&item.pcm, &decoded, ch_n, lag);
    Ok(ExtResult {
        aligned,
        packet_bits,
        enc_secs,
        dec_secs,
        lag,
    })
}

/// Моно-микс interleaved-сигнала в f64.
fn mono_mix(x: &[f32], ch: usize) -> Vec<f64> {
    let frames = x.len() / ch;
    let mut out = Vec::with_capacity(frames);
    for j in 0..frames {
        let mut acc = 0f64;
        for c in 0..ch {
            acc += f64::from(x[j * ch + c]);
        }
        out.push(acc / ch as f64);
    }
    out
}

/// Нормированная кросс-корреляция `a[i]·b[i+lag]` по зоне перекрытия
/// (не более `cap` точек).
fn ncc(a: &[f64], b: &[f64], lag: i64, cap: usize) -> f64 {
    let i0 = (-lag).max(0) as usize;
    let i1_signed = (a.len() as i64).min(b.len() as i64 - lag);
    if i1_signed <= i0 as i64 {
        return 0.0;
    }
    let i1 = (i1_signed as usize).min(i0.saturating_add(cap));
    let (mut dot, mut aa, mut bb) = (0f64, 0f64, 0f64);
    for i in i0..i1 {
        let x = a[i];
        let y = b[(i as i64 + lag) as usize];
        dot += x * y;
        aa += x * x;
        bb += y * y;
    }
    let denom = (aa * bb).sqrt();
    if denom <= 0.0 { 0.0 } else { dot / denom }
}

/// Сдвиг декода относительно эталона: `decoded[i + lag] ≈ reference[i]`.
/// Двухэтапно: грубый поиск по энергетическим огибающим (блоки ENV_BLOCK),
/// затем точный по волне вокруг грубой оценки.
fn find_lag(reference: &[f32], decoded: &[f32], ch: usize) -> i64 {
    let r = mono_mix(reference, ch);
    let d = mono_mix(decoded, ch);
    if r.len() < 2 * ENV_BLOCK || d.len() < 2 * ENV_BLOCK {
        return 0;
    }

    let envelope = |m: &[f64]| -> Vec<f64> {
        m.chunks_exact(ENV_BLOCK)
            .map(|blk| blk.iter().map(|v| v * v).sum())
            .collect()
    };
    let re = envelope(&r);
    let de = envelope(&d);

    let max_blk = MAX_LAG / ENV_BLOCK as i64;
    let mut best_blk = 0i64;
    let mut best_score = f64::NEG_INFINITY;
    for lb in -max_blk..=max_blk {
        let score = ncc(&re, &de, lb, usize::MAX);
        if score > best_score {
            best_score = score;
            best_blk = lb;
        }
    }
    if best_score <= 0.0 {
        return 0; // декод не коррелирует (например, тишина) — без сдвига
    }

    // Точный поиск по волне: ±2 блока вокруг грубой оценки.
    let base = best_blk * ENV_BLOCK as i64;
    let span = 2 * ENV_BLOCK as i64;
    let mut best_lag = base;
    let mut best_fine = f64::NEG_INFINITY;
    for lag in (base - span)..=(base + span) {
        if lag.abs() > MAX_LAG {
            continue;
        }
        let score = ncc(&r, &d, lag, FINE_WINDOW_CAP);
        if score > best_fine {
            best_fine = score;
            best_lag = lag;
        }
    }
    best_lag
}

/// Строит декод длины эталона: `aligned[i] = decoded[i + lag]`,
/// вне диапазона — нули (честный штраф за срезанные края).
fn apply_lag(reference: &[f32], decoded: &[f32], ch: usize, lag: i64) -> Vec<f32> {
    let frames = reference.len() / ch;
    let dec_frames = (decoded.len() / ch) as i64;
    let mut out = vec![0f32; reference.len()];
    for i in 0..frames {
        let src = i as i64 + lag;
        if src >= 0 && src < dec_frames {
            let s = src as usize;
            out[i * ch..(i + 1) * ch].copy_from_slice(&decoded[s * ch..(s + 1) * ch]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Детерминированный тестовый сигнал с транзиентами и тоном.
    fn test_signal(n: usize) -> Vec<f32> {
        let mut state = 0xC0FF_EE11u32;
        (0..n)
            .map(|j| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                let noise = (state as f32 / 2f32.powi(31)) - 1.0;
                let tone = (2.0 * core::f32::consts::PI * 440.0 * j as f32 / 48_000.0).sin();
                let click = if j % 9600 < 48 { 0.7 * noise } else { 0.0 };
                0.3 * tone + 0.05 * noise + click
            })
            .collect()
    }

    #[test]
    fn find_lag_recovers_positive_delay() {
        let x = test_signal(48_000 * 2);
        // Декод с 700 лишними сэмплами в начале: decoded[i + 700] = x[i].
        let mut delayed = vec![0f32; 700];
        delayed.extend_from_slice(&x);
        assert_eq!(find_lag(&x, &delayed, 1), 700);
        let aligned = apply_lag(&x, &delayed, 1, 700);
        assert_eq!(aligned, x);
    }

    #[test]
    fn find_lag_recovers_truncated_start() {
        let x = test_signal(48_000 * 2);
        // Декод без первых 300 сэмплов: decoded[i - 300] = x[i].
        let truncated = x[300..].to_vec();
        assert_eq!(find_lag(&x, &truncated, 1), -300);
        // Выравнивание: срезанное начало — нули, дальше точное совпадение.
        let aligned = apply_lag(&x, &truncated, 1, -300);
        assert!(aligned[..300].iter().all(|&v| v == 0.0));
        assert_eq!(&aligned[300..], &x[300..]);
    }

    #[test]
    fn find_lag_stereo_and_zero() {
        let mono = test_signal(48_000);
        let stereo: Vec<f32> = mono.iter().flat_map(|&v| [v, -0.5 * v]).collect();
        assert_eq!(find_lag(&stereo, &stereo, 2), 0);
        let silent = vec![0f32; stereo.len()];
        assert_eq!(find_lag(&stereo, &silent, 2), 0);
    }
}
