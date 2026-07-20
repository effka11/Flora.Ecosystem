//! Объективные метрики качества полигона FRC-A.
//!
//! Все метрики считаются от пары (эталон, декод) выровненной длины и той же
//! сетки полос, что у кодека (`frc_a_core::bands`) — деградация видна в тех же
//! координатах, в которых кодек принимает решения. NMR — упрощённая
//! модель маскирования (растекание по полосам + смещение), метрика
//! **относительная**: пригодна для A/B и регрессий, но не претендует на
//! абсолютную перцептивную шкалу PEAQ.

use frc_a_core::mdct::Mdct;
use frc_a_core::{FRAME_N, bands};
use serde::{Deserialize, Serialize};

/// Шаг анализа: 10 мс @ 48 кГц (окно анализа 2·FRAME_N, перекрытие 75%).
const HOP: usize = FRAME_N / 2;
/// Сегмент seg-SNR: 10 мс.
const SEG: usize = 480;
/// Пол активности сегмента (мощность на сэмпл): ниже — сегмент не считается.
const SEG_ACTIVE_FLOOR: f64 = 1e-8;
/// Кламп сегментного SNR, дБ (классические границы seg-SNR).
const SEG_SNR_CLAMP: (f64, f64) = (-10.0, 80.0);

/// Смещение порога маскирования от энергии полосы-маскера, дБ.
const MASK_OFFSET_DB: f64 = 18.0;
/// Спад растекания маскирования вверх по частоте, дБ/полосу.
const SPREAD_UP_DB: f64 = 15.0;
/// Спад растекания вниз по частоте, дБ/полосу.
const SPREAD_DOWN_DB: f64 = 27.0;
/// Пол маскирования относительно пиковой энергии полосы файла (≈ порог
/// слышимости в шкале файла): −90 дБ.
const ATH_REL_DB: f64 = -90.0;

/// Порог «тихой» полосы для band-LSD и стерео-метрик, дБ от пика файла.
const QUIET_BAND_DB: f64 = -60.0;

/// Окно pre-echo перед атакой: 13 мс, защитный зазор 2 мс.
const PRE_WINDOW: usize = 624;
const PRE_GUARD: usize = 96;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QualityReport {
    /// Глобальный waveform-SNR, дБ.
    pub snr_db: f64,
    /// Средний сегментный SNR (10 мс, кламп −10..80 дБ, активные сегменты).
    pub seg_snr_db: f64,
    /// Средняя лог-спектральная дистанция по полосам кодека, дБ.
    pub band_lsd_db: f64,
    /// Noise-to-mask ratio (средний по кадрам), дБ; меньше — лучше,
    /// отрицательный ≈ шум под порогом маскирования.
    pub nmr_db: f64,
    /// NMR худшего кадра, дБ.
    pub worst_nmr_db: f64,
    /// Pre-echo: 20·log10(RMS ошибки в окне 13 мс перед атакой / RMS самой
    /// атаки) — размазывание относительно маскера; −60 дБ и ниже ≈ неслышимо,
    /// −20 дБ и выше — вероятно слышимый смаз. None — атак в эталоне нет.
    pub pre_echo_db: Option<f64>,
    /// Средняя ошибка межканальной разности уровней по полосам, дБ (стерео).
    pub stereo_ild_err_db: Option<f64>,
    /// Дрейф side-энергии: 10·log10(Σ side_dec² / Σ side_ref²), дБ (стерео;
    /// 0 — образ сохранён, минус — сцена схлопнулась, плюс — расширилась).
    pub side_drift_db: Option<f64>,
}

/// Сводная оценка пары сигналов (interleaved, каналы `ch`).
pub fn evaluate(reference: &[f32], decoded: &[f32], ch: usize) -> QualityReport {
    assert_eq!(reference.len(), decoded.len());
    assert!(ch == 1 || ch == 2);
    let spec = SpectralPair::analyze(reference, decoded, ch);
    let (nmr_db, worst_nmr_db) = spec.nmr();
    QualityReport {
        snr_db: snr_db(reference, decoded),
        seg_snr_db: seg_snr_db(reference, decoded, ch),
        band_lsd_db: spec.band_lsd(),
        nmr_db,
        worst_nmr_db,
        pre_echo_db: pre_echo_db(reference, decoded, ch),
        stereo_ild_err_db: (ch == 2).then(|| spec.ild_error()),
        side_drift_db: (ch == 2).then(|| side_drift_db(reference, decoded)),
    }
}

pub fn snr_db(reference: &[f32], decoded: &[f32]) -> f64 {
    let mut sig = 0f64;
    let mut err = 0f64;
    for (&a, &b) in reference.iter().zip(decoded) {
        sig += f64::from(a) * f64::from(a);
        let e = f64::from(a) - f64::from(b);
        err += e * e;
    }
    if err == 0.0 {
        return f64::INFINITY;
    }
    10.0 * (sig / err).log10()
}

/// Сегментный SNR: среднее по 10-мс сегментам с активным эталоном.
pub fn seg_snr_db(reference: &[f32], decoded: &[f32], ch: usize) -> f64 {
    let total = reference.len() / ch;
    let mut sum = 0f64;
    let mut count = 0u64;
    let mut seg = 0usize;
    while (seg + 1) * SEG <= total {
        let mut sig = 0f64;
        let mut err = 0f64;
        for j in seg * SEG..(seg + 1) * SEG {
            for c in 0..ch {
                let a = f64::from(reference[j * ch + c]);
                let b = f64::from(decoded[j * ch + c]);
                sig += a * a;
                err += (a - b) * (a - b);
            }
        }
        let power = sig / (SEG * ch) as f64;
        if power > SEG_ACTIVE_FLOOR {
            let snr = if err == 0.0 {
                SEG_SNR_CLAMP.1
            } else {
                (10.0 * (sig / err).log10()).clamp(SEG_SNR_CLAMP.0, SEG_SNR_CLAMP.1)
            };
            sum += snr;
            count += 1;
        }
        seg += 1;
    }
    if count == 0 {
        f64::NAN
    } else {
        sum / count as f64
    }
}

/// Спектральный анализ пары: энергии полос эталона, декода и ошибки по
/// перекрывающимся кадрам (окно 2·FRAME_N полного перекрытия, шаг 10 мс).
struct SpectralPair {
    /// [кадр][канал][полоса]
    ref_e: Vec<Vec<[f64; bands::NUM_BANDS]>>,
    dec_e: Vec<Vec<[f64; bands::NUM_BANDS]>>,
    err_e: Vec<Vec<[f64; bands::NUM_BANDS]>>,
    /// Пиковая энергия полосы эталона по файлу (шкала маскирования/порогов).
    peak_band_e: f64,
}

impl SpectralPair {
    fn analyze(reference: &[f32], decoded: &[f32], ch: usize) -> Self {
        let mdct = Mdct::new(FRAME_N, FRAME_N);
        let total = reference.len() / ch;
        let frames = if total >= 2 * FRAME_N {
            (total - 2 * FRAME_N) / HOP + 1
        } else {
            0
        };
        let mut ref_e = Vec::with_capacity(frames);
        let mut dec_e = Vec::with_capacity(frames);
        let mut err_e = Vec::with_capacity(frames);
        let mut peak = 0f64;
        let mut window = vec![0f32; 2 * FRAME_N];
        let mut coeffs_ref = vec![0f32; FRAME_N];
        let mut coeffs_dec = vec![0f32; FRAME_N];
        for f in 0..frames {
            let start = f * HOP;
            let mut fr = Vec::with_capacity(ch);
            let mut fd = Vec::with_capacity(ch);
            let mut fe = Vec::with_capacity(ch);
            for c in 0..ch {
                for (i, w) in window.iter_mut().enumerate() {
                    *w = reference[(start + i) * ch + c];
                }
                mdct.forward(&window, &mut coeffs_ref);
                for (i, w) in window.iter_mut().enumerate() {
                    *w = decoded[(start + i) * ch + c];
                }
                mdct.forward(&window, &mut coeffs_dec);
                let mut re = [0f64; bands::NUM_BANDS];
                let mut de = [0f64; bands::NUM_BANDS];
                let mut ee = [0f64; bands::NUM_BANDS];
                for b in 0..bands::NUM_BANDS {
                    for i in bands::band_range(b) {
                        let r = f64::from(coeffs_ref[i]);
                        let d = f64::from(coeffs_dec[i]);
                        re[b] += r * r;
                        de[b] += d * d;
                        ee[b] += (d - r) * (d - r);
                    }
                    peak = peak.max(re[b]);
                }
                fr.push(re);
                fd.push(de);
                fe.push(ee);
            }
            ref_e.push(fr);
            dec_e.push(fd);
            err_e.push(fe);
        }
        Self {
            ref_e,
            dec_e,
            err_e,
            peak_band_e: peak.max(1e-30),
        }
    }

    /// Средняя |лог-спектральная дистанция| по полосам громче QUIET_BAND_DB.
    fn band_lsd(&self) -> f64 {
        let quiet = self.peak_band_e * 10f64.powf(QUIET_BAND_DB / 10.0);
        let mut sum = 0f64;
        let mut count = 0u64;
        for (fr, fd) in self.ref_e.iter().zip(&self.dec_e) {
            for (re, de) in fr.iter().zip(fd) {
                for b in 0..bands::NUM_BANDS {
                    if re[b] > quiet {
                        sum += (10.0 * (re[b] / de[b].max(1e-30)).log10()).abs();
                        count += 1;
                    }
                }
            }
        }
        if count == 0 { 0.0 } else { sum / count as f64 }
    }

    /// (средний NMR, худший кадровый NMR) в дБ. Порог полосы — максимум
    /// растекания энергий эталона (сдвиг MASK_OFFSET_DB, асимметричные
    /// склоны) и пола слышимости ATH_REL_DB от пика файла.
    fn nmr(&self) -> (f64, f64) {
        let ath = self.peak_band_e * 10f64.powf(ATH_REL_DB / 10.0);
        let mut total_ratio = 0f64;
        let mut frames = 0u64;
        let mut worst = f64::NEG_INFINITY;
        for (fr, fe) in self.ref_e.iter().zip(&self.err_e) {
            let mut frame_ratio = 0f64;
            let mut bands_n = 0u64;
            for (re, ee) in fr.iter().zip(fe) {
                for (b, &err_b) in ee.iter().enumerate() {
                    let mut mask = ath;
                    for (j, &e) in re.iter().enumerate() {
                        let dist_db = if j <= b {
                            SPREAD_UP_DB * (b - j) as f64
                        } else {
                            SPREAD_DOWN_DB * (j - b) as f64
                        };
                        mask = mask.max(e * 10f64.powf(-(MASK_OFFSET_DB + dist_db) / 10.0));
                    }
                    frame_ratio += err_b / mask;
                    bands_n += 1;
                }
            }
            if bands_n > 0 {
                let r = frame_ratio / bands_n as f64;
                total_ratio += r;
                frames += 1;
                worst = worst.max(10.0 * r.max(1e-30).log10());
            }
        }
        if frames == 0 {
            return (f64::NAN, f64::NAN);
        }
        let mean = 10.0 * (total_ratio / frames as f64).max(1e-30).log10();
        (mean, worst)
    }

    /// Средняя ошибка ILD (межканальной разности уровней) по полосам, где
    /// оба канала эталона громче QUIET_BAND_DB.
    fn ild_error(&self) -> f64 {
        let quiet = self.peak_band_e * 10f64.powf(QUIET_BAND_DB / 10.0);
        let mut sum = 0f64;
        let mut count = 0u64;
        for (fr, fd) in self.ref_e.iter().zip(&self.dec_e) {
            if fr.len() < 2 {
                continue;
            }
            for b in 0..bands::NUM_BANDS {
                let (rl, rr) = (fr[0][b], fr[1][b]);
                if rl > quiet && rr > quiet {
                    let ild_ref = 10.0 * (rl / rr).log10();
                    let ild_dec = 10.0 * (fd[0][b].max(1e-30) / fd[1][b].max(1e-30)).log10();
                    sum += (ild_ref - ild_dec).abs();
                    count += 1;
                }
            }
        }
        if count == 0 { 0.0 } else { sum / count as f64 }
    }
}

/// Дрейф side-энергии стереопары во временнóй области.
fn side_drift_db(reference: &[f32], decoded: &[f32]) -> f64 {
    let mut side_ref = 0f64;
    let mut side_dec = 0f64;
    for j in 0..reference.len() / 2 {
        let sr = f64::from(reference[2 * j]) - f64::from(reference[2 * j + 1]);
        let sd = f64::from(decoded[2 * j]) - f64::from(decoded[2 * j + 1]);
        side_ref += sr * sr;
        side_dec += sd * sd;
    }
    if side_ref < 1e-12 {
        return 0.0;
    }
    10.0 * (side_dec / side_ref).log10()
}

/// Pre-echo: находит атаки в эталоне (скачок энергии первой разности
/// суб-блока N/8 более чем в 8 раз к максимуму двух предыдущих — тот же
/// критерий, что у детектора кодека) и меряет RMS ошибки в окне 13 мс перед
/// атакой (зазор 2 мс) относительно RMS **самой атаки** (маскера): смаз
/// в тихом окне слышен настолько, насколько он громок против атаки.
fn pre_echo_db(reference: &[f32], decoded: &[f32], ch: usize) -> Option<f64> {
    const SUB: usize = FRAME_N / 8;
    /// Длина участка атаки, задающего опорный уровень (5 мс).
    const ATTACK_REF: usize = 240;
    let total = reference.len() / ch;
    if total < 3 * SUB + PRE_WINDOW {
        return None;
    }
    // Моно-микс энергий первой разности по суб-блокам.
    let blocks = total / SUB;
    let mut e = vec![0f64; blocks];
    for (blk, eb) in e.iter_mut().enumerate() {
        let s = blk * SUB;
        for j in s.max(1)..s + SUB {
            for c in 0..ch {
                let d = f64::from(reference[j * ch + c]) - f64::from(reference[(j - 1) * ch + c]);
                *eb += d * d;
            }
        }
    }
    let mut attacks = Vec::new();
    let mut last = 0usize;
    for blk in 2..blocks {
        let past = e[blk - 1].max(e[blk - 2]);
        if e[blk] > 1e-7 && e[blk] > 8.0 * past + 1e-7 {
            let pos = blk * SUB;
            // Не ближе одного окна к предыдущей атаке, началу и концу файла.
            if pos >= PRE_WINDOW + PRE_GUARD && pos + ATTACK_REF <= total && pos - last > PRE_WINDOW
            {
                attacks.push(pos);
                last = pos;
            }
        }
    }
    if attacks.is_empty() {
        return None;
    }
    let mut sum = 0f64;
    for &pos in &attacks {
        let rms = |x: &[f32], a: usize, b: usize| -> f64 {
            let mut acc = 0f64;
            for j in a..b {
                for c in 0..ch {
                    acc += f64::from(x[j * ch + c]) * f64::from(x[j * ch + c]);
                }
            }
            (acc / ((b - a) * ch) as f64).sqrt()
        };
        let (a, b) = (pos - PRE_WINDOW - PRE_GUARD, pos - PRE_GUARD);
        let mut err_acc = 0f64;
        for j in a..b {
            for c in 0..ch {
                let d = f64::from(reference[j * ch + c]) - f64::from(decoded[j * ch + c]);
                err_acc += d * d;
            }
        }
        let err_rms = (err_acc / ((b - a) * ch) as f64).sqrt();
        let attack_rms = rms(reference, pos, pos + ATTACK_REF);
        sum += 20.0 * (err_rms / attack_rms.max(1e-12)).max(1e-9).log10();
    }
    Some(sum / attacks.len() as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(n: usize, f: f32, amp: f32) -> Vec<f32> {
        (0..n)
            .map(|j| amp * (2.0 * core::f32::consts::PI * f * j as f32 / 48_000.0).sin())
            .collect()
    }

    #[test]
    fn identical_signals_are_perfect() {
        let x = tone(48_000 * 2, 440.0, 0.5);
        let r = evaluate(&x, &x, 1);
        assert!(r.snr_db.is_infinite());
        assert!(r.seg_snr_db > 79.0);
        assert!(r.band_lsd_db < 1e-9);
        // Ошибка ноль → NMR упирается в пол логарифма.
        assert!(r.nmr_db < -100.0);
        assert!(r.pre_echo_db.is_none());
    }

    #[test]
    fn added_noise_degrades_metrics_monotonically() {
        let x = tone(48_000 * 2, 440.0, 0.5);
        let noisy = |amp: f32| -> Vec<f32> {
            let mut state = 0x1234_5678u32;
            x.iter()
                .map(|&v| {
                    state ^= state << 13;
                    state ^= state >> 17;
                    state ^= state << 5;
                    v + amp * ((state as f32 / 2f32.powi(31)) - 1.0)
                })
                .collect()
        };
        let a = evaluate(&x, &noisy(0.001), 1);
        let b = evaluate(&x, &noisy(0.01), 1);
        assert!(a.snr_db > b.snr_db + 10.0);
        assert!(a.seg_snr_db > b.seg_snr_db + 10.0);
        assert!(a.nmr_db < b.nmr_db - 10.0);
        assert!(a.band_lsd_db < b.band_lsd_db);
    }

    #[test]
    fn pre_echo_detects_smear_before_click() {
        let n = 48_000usize;
        let mut x = vec![0f32; n];
        // Тихий фон + резкий щелчок.
        for (j, v) in x.iter_mut().enumerate() {
            *v = 0.02 * (2.0 * core::f32::consts::PI * 300.0 * j as f32 / 48_000.0).sin();
        }
        let click_at = 24_000;
        let mut state = 0xBEEFu32;
        for v in &mut x[click_at..click_at + 96] {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            *v += 0.8 * ((state as f32 / 2f32.powi(31)) - 1.0);
        }
        // «Декод» с размазанной перед атакой ошибкой.
        let mut smeared = x.clone();
        for v in &mut smeared[click_at - 600..click_at - 100] {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            *v += 0.05 * ((state as f32 / 2f32.powi(31)) - 1.0);
        }
        let clean = pre_echo_db(&x, &x, 1).expect("атака должна быть найдена");
        let smear = pre_echo_db(&x, &smeared, 1).expect("атака должна быть найдена");
        assert!(clean < -170.0, "чистый сигнал: {clean}");
        // Шум −20 дБ относительно атаки в окне перед ней должен быть виден.
        assert!(smear > -30.0 && smear < -10.0, "размазывание: {smear}");
    }

    #[test]
    fn stereo_collapse_is_visible() {
        // Широкая стереопара: L и R — разные тона.
        let n = 48_000usize;
        let l = tone(n, 400.0, 0.4);
        let r = tone(n, 570.0, 0.4);
        let wide: Vec<f32> = l.iter().zip(&r).flat_map(|(&a, &b)| [a, b]).collect();
        // «Схлопнутый» декод: оба канала — среднее.
        let mono: Vec<f32> = l
            .iter()
            .zip(&r)
            .flat_map(|(&a, &b)| {
                let m = 0.5 * (a + b);
                [m, m]
            })
            .collect();
        let rep = evaluate(&wide, &mono, 2);
        assert!(
            rep.side_drift_db.unwrap() < -30.0,
            "{:?}",
            rep.side_drift_db
        );
        assert!(rep.stereo_ild_err_db.unwrap() >= 0.0);
        let same = evaluate(&wide, &wide, 2);
        assert!(same.side_drift_db.unwrap().abs() < 1e-9);
    }
}
