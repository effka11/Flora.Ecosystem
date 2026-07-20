//! Отчёты полигона: текстовая таблица, JSON-снимок и сравнение с baseline
//! (регрессионные допуски по каждой метрике).

use serde::{Deserialize, Serialize};

use crate::runner::CaseResult;

pub const SCHEMA_VERSION: u32 = 1;

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

/// Текстовая таблица результатов.
pub fn table(results: &[CaseResult]) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "{:<24} {:>4} {:>6} {:>6} {:>7} {:>6} {:>6} {:>6} {:>7} {:>6} {:>6} {:>5} {:>7}\n",
        "кейс",
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
            "{:<24} {:>4} {:>6.1} {:>6.1} {:>7.1} {:>6.2} {:>6.1} {:>6.1} {:>7} {:>6} {:>6} {:>5.0} {:>7.0}\n",
            r.item,
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
/// по (item, bitrate, variant); отсутствующие в новом снимке — тоже регрессия.
pub fn regressions(old: &Snapshot, new: &Snapshot, tol: Tolerance) -> Vec<String> {
    let mut problems = Vec::new();
    for o in &old.results {
        let Some(n) = new.results.iter().find(|n| {
            n.item == o.item && n.bitrate_kbps == o.bitrate_kbps && n.variant == o.variant
        }) else {
            problems.push(format!(
                "{} @{}k [{}]: кейс исчез из нового снимка",
                o.item,
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
                        o.item,
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
        "{:<24} {:>4} {:>7} {:>8} {:>7} {:>7} {:>8} {:>8}\n",
        "кейс", "кбит", "ΔSNR", "ΔsegSNR", "ΔLSD", "ΔNMR", "ΔwNMR", "Δфакт"
    ));
    for o in &old.results {
        let Some(n) = new.results.iter().find(|n| {
            n.item == o.item && n.bitrate_kbps == o.bitrate_kbps && n.variant == o.variant
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
            "{:<24} {:>4} {:>7} {:>8} {:>7} {:>7} {:>8} {:>8}\n",
            o.item,
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
