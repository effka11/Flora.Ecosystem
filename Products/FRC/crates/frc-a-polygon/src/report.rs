//! Отчёты полигона: текстовая таблица, JSON-снимок, сравнение с baseline
//! (регрессионные допуски по каждой метрике) и сводка арены против
//! внешних кодеков.

use serde::{Deserialize, Serialize};

use crate::runner::{CaseResult, FRC_A_ID};

/// v2: результат несёт поле `codec` (арена). Снимки v1 читаются —
/// отсутствующий `codec` десериализуется как `frc-a`.
pub const SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub schema: u32,
    /// Свободная метка снимка (версия кодека, ветка, дата).
    pub label: String,
    pub results: Vec<CaseResult>,
}

impl Snapshot {
    pub fn new(label: impl Into<String>, results: Vec<CaseResult>) -> Self {
        Self {
            schema: SCHEMA_VERSION,
            label: label.into(),
            results,
        }
    }
}

/// Допуски регрессий (насколько новой метрике позволено быть хуже старой).
#[derive(Debug, Clone, Copy)]
pub struct Tolerance {
    pub snr_db: f64,
    pub seg_snr_db: f64,
    pub band_lsd_db: f64,
    pub nmr_db: f64,
    pub worst_nmr_db: f64,
    pub pre_echo_db: f64,
    pub stereo_ild_err_db: f64,
    pub side_drift_db: f64,
    /// Превышение целевого битрейта, kbps.
    pub bitrate_kbps: f64,
}

impl Default for Tolerance {
    fn default() -> Self {
        Self {
            snr_db: 0.75,
            seg_snr_db: 0.75,
            band_lsd_db: 0.25,
            nmr_db: 0.75,
            worst_nmr_db: 1.5,
            pre_echo_db: 2.0,
            stereo_ild_err_db: 0.5,
            side_drift_db: 0.75,
            bitrate_kbps: 1.0,
        }
    }
}

fn fmt_opt(v: Option<f64>) -> String {
    v.map_or_else(|| "—".into(), |x| format!("{x:.1}"))
}

/// Подпись строки в отчётах сравнения: кейс конкурента помечается кодеком.
fn row_label(item: &str, codec: &str) -> String {
    if codec == FRC_A_ID {
        item.to_string()
    } else {
        format!("{item}·{codec}")
    }
}

/// Текстовая таблица результатов.
pub fn table(results: &[CaseResult]) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "{:<24} {:<7} {:>4} {:>6} {:>6} {:>7} {:>6} {:>6} {:>6} {:>7} {:>6} {:>6} {:>5} {:>7}\n",
        "кейс",
        "кодек",
        "кбит",
        "факт",
        "SNR",
        "segSNR",
        "LSD",
        "NMR",
        "wNMR",
        "preEcho",
        "ILDe",
        "side",
        "T%",
        "enc×RT"
    ));
    for r in results {
        out.push_str(&format!(
            "{:<24} {:<7} {:>4} {:>6.1} {:>6.1} {:>7.1} {:>6.2} {:>6.1} {:>6.1} {:>7} {:>6} {:>6} {:>5.0} {:>7.0}\n",
            r.item,
            r.codec,
            r.bitrate_kbps,
            r.actual_kbps,
            r.quality.snr_db.min(999.9),
            r.quality.seg_snr_db,
            r.quality.band_lsd_db,
            r.quality.nmr_db,
            r.quality.worst_nmr_db,
            fmt_opt(r.quality.pre_echo_db),
            fmt_opt(r.quality.stereo_ild_err_db),
            fmt_opt(r.quality.side_drift_db),
            r.transient_share * 100.0,
            r.enc_rt_factor,
        ));
    }
    out
}

/// Найденные регрессии (пустой список — всё в допусках). Кейсы сопоставляются
/// по (item, codec, bitrate, variant); отсутствующие в новом снимке — тоже
/// регрессия. Строки конкурентов сравниваются только с конкурентами.
pub fn regressions(old: &Snapshot, new: &Snapshot, tol: Tolerance) -> Vec<String> {
    let mut problems = Vec::new();
    for o in &old.results {
        let Some(n) = new.results.iter().find(|n| {
            n.item == o.item
                && n.codec == o.codec
                && n.bitrate_kbps == o.bitrate_kbps
                && n.variant == o.variant
        }) else {
            problems.push(format!(
                "{} @{}k [{}]: кейс исчез из нового снимка",
                row_label(&o.item, &o.codec),
                o.bitrate_kbps,
                o.variant.label()
            ));
            continue;
        };
        let mut check =
            |metric: &str, old_v: f64, new_v: f64, allowed: f64, higher_better: bool| {
                if !old_v.is_finite() || !new_v.is_finite() {
                    return;
                }
                let degraded = if higher_better {
                    old_v - new_v
                } else {
                    new_v - old_v
                };
                if degraded > allowed {
                    problems.push(format!(
                        "{} @{}k [{}]: {metric} {old_v:.2} → {new_v:.2} (допуск {allowed})",
                        row_label(&o.item, &o.codec),
                        o.bitrate_kbps,
                        o.variant.label()
                    ));
                }
            };
        let (oq, nq) = (&o.quality, &n.quality);
        check("SNR", oq.snr_db, nq.snr_db, tol.snr_db, true);
        check("segSNR", oq.seg_snr_db, nq.seg_snr_db, tol.seg_snr_db, true);
        check(
            "band-LSD",
            oq.band_lsd_db,
            nq.band_lsd_db,
            tol.band_lsd_db,
            false,
        );
        check("NMR", oq.nmr_db, nq.nmr_db, tol.nmr_db, false);
        check(
            "worstNMR",
            oq.worst_nmr_db,
            nq.worst_nmr_db,
            tol.worst_nmr_db,
            false,
        );
        if let (Some(op), Some(np)) = (oq.pre_echo_db, nq.pre_echo_db) {
            check("pre-echo", op, np, tol.pre_echo_db, false);
        }
        if let (Some(oi), Some(ni)) = (oq.stereo_ild_err_db, nq.stereo_ild_err_db) {
            check("ILD-err", oi, ni, tol.stereo_ild_err_db, false);
        }
        if let (Some(os), Some(ns)) = (oq.side_drift_db, nq.side_drift_db) {
            check("side-drift", os.abs(), ns.abs(), tol.side_drift_db, false);
        }
        check(
            "битрейт",
            o.actual_kbps.max(f64::from(o.bitrate_kbps)),
            n.actual_kbps,
            tol.bitrate_kbps,
            false,
        );
    }
    problems
}

/// Таблица дельт «новый − старый» по совпадающим кейсам (для A/B-обзора).
pub fn delta_table(old: &Snapshot, new: &Snapshot) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "{:<30} {:>4} {:>7} {:>8} {:>7} {:>7} {:>8} {:>8}\n",
        "кейс", "кбит", "ΔSNR", "ΔsegSNR", "ΔLSD", "ΔNMR", "ΔwNMR", "Δфакт"
    ));
    for o in &old.results {
        let Some(n) = new.results.iter().find(|n| {
            n.item == o.item
                && n.codec == o.codec
                && n.bitrate_kbps == o.bitrate_kbps
                && n.variant == o.variant
        }) else {
            continue;
        };
        let d = |a: f64, b: f64| {
            if a.is_finite() && b.is_finite() {
                format!("{:+.2}", b - a)
            } else {
                "—".into()
            }
        };
        out.push_str(&format!(
            "{:<30} {:>4} {:>7} {:>8} {:>7} {:>7} {:>8} {:>8}\n",
            row_label(&o.item, &o.codec),
            o.bitrate_kbps,
            d(o.quality.snr_db, n.quality.snr_db),
            d(o.quality.seg_snr_db, n.quality.seg_snr_db),
            d(o.quality.band_lsd_db, n.quality.band_lsd_db),
            d(o.quality.nmr_db, n.quality.nmr_db),
            d(o.quality.worst_nmr_db, n.quality.worst_nmr_db),
            d(o.actual_kbps, n.actual_kbps),
        ));
    }
    out
}

/// Сводка арены: победы/поражения FRC-A против каждого конкурента и топ
/// кейсов-разрывов. Пары сопоставляются по (кейс, битрейт); пустая строка,
/// если строк конкурентов нет.
///
/// Конвенция знаков: Δ = frc-a − конкурент. NMR и LSD «меньше — лучше»
/// (Δ < 0 — мы лучше), segSNR «больше — лучше» (Δ > 0 — мы лучше).
pub fn arena_summary(results: &[CaseResult]) -> String {
    use std::collections::{BTreeMap, BTreeSet};

    let competitors: BTreeSet<&str> = results
        .iter()
        .map(|r| r.codec.as_str())
        .filter(|c| *c != FRC_A_ID)
        .collect();
    if competitors.is_empty() {
        return String::new();
    }
    let ours: BTreeMap<(&str, u32), &CaseResult> = results
        .iter()
        .filter(|r| r.codec == FRC_A_ID)
        .map(|r| ((r.item.as_str(), r.bitrate_kbps), r))
        .collect();

    let median = |sorted: &[f64]| -> f64 {
        let n = sorted.len();
        if n == 0 {
            return f64::NAN;
        }
        if n % 2 == 1 {
            sorted[n / 2]
        } else {
            0.5 * (sorted[n / 2 - 1] + sorted[n / 2])
        }
    };

    let mut out =
        String::from("\nарена (Δ = frc-a − конкурент; ΔNMR/ΔLSD < 0 и ΔsegSNR > 0 — мы лучше):\n");
    for comp in competitors {
        // (Δ, подпись) по каждой метрике; NMR — главная (перцептивный прокси).
        let mut d_nmr: Vec<(f64, String)> = Vec::new();
        let (mut wins_seg, mut tot_seg) = (0usize, 0usize);
        let (mut wins_lsd, mut tot_lsd) = (0usize, 0usize);
        // Битрейт → (победы по NMR, всего, сумма ΔNMR).
        let mut per_rate: BTreeMap<u32, (usize, usize, f64)> = BTreeMap::new();
        let (mut ratio_sum, mut ratio_n) = (0f64, 0usize);

        for other in results.iter().filter(|r| r.codec == comp) {
            let Some(f) = ours.get(&(other.item.as_str(), other.bitrate_kbps)) else {
                continue;
            };
            let (a, b) = (&f.quality, &other.quality);
            if a.nmr_db.is_finite() && b.nmr_db.is_finite() {
                let d = a.nmr_db - b.nmr_db;
                d_nmr.push((d, format!("{}@{}k", f.item, f.bitrate_kbps)));
                let e = per_rate.entry(f.bitrate_kbps).or_insert((0, 0, 0.0));
                if d < 0.0 {
                    e.0 += 1;
                }
                e.1 += 1;
                e.2 += d;
            }
            if a.seg_snr_db.is_finite() && b.seg_snr_db.is_finite() {
                tot_seg += 1;
                if a.seg_snr_db > b.seg_snr_db {
                    wins_seg += 1;
                }
            }
            if a.band_lsd_db.is_finite() && b.band_lsd_db.is_finite() {
                tot_lsd += 1;
                if a.band_lsd_db < b.band_lsd_db {
                    wins_lsd += 1;
                }
            }
            ratio_sum += other.actual_kbps / f64::from(other.bitrate_kbps);
            ratio_n += 1;
        }
        if d_nmr.is_empty() && tot_seg == 0 {
            continue;
        }

        let wins_nmr = d_nmr.iter().filter(|(d, _)| *d < 0.0).count();
        let mut sorted: Vec<f64> = d_nmr.iter().map(|(d, _)| *d).collect();
        sorted.sort_by(f64::total_cmp);
        let mean = sorted.iter().sum::<f64>() / sorted.len().max(1) as f64;
        out.push_str(&format!(
            "vs {:<7}: NMR {}/{} · segSNR {}/{} · LSD {}/{} побед; ΔNMR средн {:+.1} дБ, медиана {:+.1} дБ\n",
            comp,
            wins_nmr,
            d_nmr.len(),
            wins_seg,
            tot_seg,
            wins_lsd,
            tot_lsd,
            mean,
            median(&sorted),
        ));
        for (rate, (w, t, sum)) in &per_rate {
            out.push_str(&format!(
                "    @{rate}k: NMR {w}/{t} побед, ΔNMR средн {:+.1} дБ\n",
                sum / *t as f64
            ));
        }

        d_nmr.sort_by(|x, y| y.0.total_cmp(&x.0));
        let fmt_top = |slice: &[(f64, String)]| -> String {
            slice
                .iter()
                .map(|(d, label)| format!("{label} {d:+.1}"))
                .collect::<Vec<_>>()
                .join(", ")
        };
        let worst: Vec<(f64, String)> = d_nmr
            .iter()
            .filter(|(d, _)| *d > 0.0)
            .take(3)
            .cloned()
            .collect();
        if !worst.is_empty() {
            out.push_str(&format!(
                "    сильнее всего проигрываем: {}\n",
                fmt_top(&worst)
            ));
        }
        let best: Vec<(f64, String)> = d_nmr
            .iter()
            .rev()
            .filter(|(d, _)| *d < 0.0)
            .take(3)
            .cloned()
            .collect();
        if !best.is_empty() {
            out.push_str(&format!(
                "    сильнее всего выигрываем: {}\n",
                fmt_top(&best)
            ));
        }
        if ratio_n > 0 {
            let ratio = ratio_sum / ratio_n as f64;
            if !(0.93..=1.07).contains(&ratio) {
                out.push_str(&format!(
                    "    ⚠ {comp}: средний факт ×{ratio:.2} от целевого битрейта — сравнение с поправкой\n"
                ));
            }
        }
    }
    out
}
