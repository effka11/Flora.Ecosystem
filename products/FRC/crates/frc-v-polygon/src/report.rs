//! Отчёты арены: BD-rate сводки, markdown-отчёт с RD-таблицами и графиками,
//! короткая текстовая сводка и сравнение снимков (прогресс/регрессии FRC-V).

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::Path;

use crate::bd::bd_rate;
use crate::runner::{RunRecord, Snapshot};
use crate::svg::{self, Series};

/// Метрики, по которым строятся BD-кривые: (id, подпись, извлечение).
type MetricFn = fn(&RunRecord) -> Option<f64>;
pub const BD_METRICS: &[(&str, &str, MetricFn)] = &[
    ("psnr_y", "PSNR-Y", |r| Some(r.psnr_y)),
    ("psnr_ov", "PSNR-ov", |r| Some(r.psnr_ov)),
    ("ssim_db", "SSIM-Y (dB)", |r| Some(ssim_to_db(r.ssim_y))),
    ("vmaf", "VMAF", |r| r.vmaf),
];

/// −10·log10(1−SSIM): линеаризация SSIM для BD-интегрирования.
fn ssim_to_db(ssim: f64) -> f64 {
    -10.0 * (1.0 - ssim.min(0.999_999)).log10()
}

fn codec_color(id: &str) -> &'static str {
    match id {
        "frcv" => "#e11d48",
        "x264" => "#2563eb",
        "x265" => "#7c3aed",
        "vp9" => "#059669",
        "svtav1" => "#d97706",
        "aom" => "#64748b",
        _ => "#111827",
    }
}

/// Клипы снимка в порядке появления.
fn clips(s: &Snapshot) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for r in &s.runs {
        if seen.insert(r.clip.clone()) {
            out.push(r.clip.clone());
        }
    }
    out
}

/// Кодеки снимка в каноническом порядке (frcv первым).
fn snapshot_codecs(s: &Snapshot) -> Vec<String> {
    let present: BTreeSet<&str> = s.runs.iter().map(|r| r.codec.as_str()).collect();
    crate::codecs::ALL_CODECS
        .iter()
        .filter(|id| present.contains(**id))
        .map(|id| (*id).to_string())
        .collect()
}

/// RD-точки кодека на клипе: (kbps, метрика). None, если метрика отсутствует
/// хотя бы в одной точке (например VMAF не считался).
fn rd_points(s: &Snapshot, clip: &str, codec: &str, metric: MetricFn) -> Option<Vec<(f64, f64)>> {
    let mut pts = Vec::new();
    for r in s.runs.iter().filter(|r| r.clip == clip && r.codec == codec) {
        pts.push((r.kbps, metric(r)?));
    }
    (pts.len() >= 2).then_some(pts)
}

/// BD-rate FRC-V против конкурента на клипе по метрике.
pub fn bd_vs(s: &Snapshot, clip: &str, competitor: &str, metric: MetricFn) -> Option<f64> {
    let anchor = rd_points(s, clip, competitor, metric)?;
    let test = rd_points(s, clip, "frcv", metric)?;
    bd_rate(&anchor, &test)
}

fn fmt_bd(v: Option<f64>) -> String {
    v.map_or_else(|| "—".into(), |x| format!("{x:+.1}%"))
}

fn geomean(values: impl Iterator<Item = f64>) -> Option<f64> {
    let (mut sum, mut n) = (0.0f64, 0u32);
    for v in values {
        if v > 0.0 {
            sum += v.ln();
            n += 1;
        }
    }
    (n > 0).then(|| (sum / f64::from(n)).exp())
}

fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

/// Средний BD-rate FRC-V против конкурента по всем клипам (и число клипов).
fn mean_bd(s: &Snapshot, competitor: &str, metric: MetricFn) -> (Option<f64>, usize) {
    let vals: Vec<f64> = clips(s)
        .iter()
        .filter_map(|c| bd_vs(s, c, competitor, metric))
        .collect();
    (mean(&vals), vals.len())
}

// ---------------------------------------------------------------------------
// Markdown-отчёт
// ---------------------------------------------------------------------------

/// Дата UTC из unix-времени (гражданский календарь, без зависимостей).
fn fmt_utc(unix: u64) -> String {
    let days = unix / 86_400;
    let secs = unix % 86_400;
    // Алгоритм civil_from_days (Howard Hinnant).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02} UTC",
        secs / 3600,
        (secs % 3600) / 60
    )
}

pub fn report_markdown(s: &Snapshot) -> String {
    let mut md = String::new();
    let codecs = snapshot_codecs(s);
    let competitors: Vec<&String> = codecs.iter().filter(|c| c.as_str() != "frcv").collect();

    let _ = writeln!(md, "# FRC-V polygon — кросс-кодек отчёт\n");
    let _ = writeln!(
        md,
        "- Снимок: **{}** ({})",
        s.label,
        fmt_utc(s.created_unix)
    );
    let _ = writeln!(md, "- {}", s.ffmpeg);
    let _ = writeln!(
        md,
        "- Условия: {} кадров/клип, keyint {}, 1 поток у всех энкодеров, elementary stream, {}",
        s.config.frames,
        s.config.keyint,
        if s.config.tune_psnr {
            "tune=psnr у x264/x265/vp9/aom"
        } else {
            "психовизуальные настройки по умолчанию"
        }
    );
    let _ = writeln!(md, "- Кодеки:");
    for id in &codecs {
        let label = s.config.codec_labels.get(id).cloned().unwrap_or_default();
        let _ = writeln!(md, "  - `{id}` — {label}");
    }
    let _ = writeln!(md);

    // Сводка BD-rate.
    let _ = writeln!(md, "## Сводка BD-rate (FRC-V против конкурента)\n");
    let _ = writeln!(
        md,
        "Отрицательное значение — FRC-V тратит меньше бит на то же качество \
         (мы лучше); положительное — конкурент впереди. Среднее по клипам.\n"
    );
    let _ = write!(md, "| Конкурент |");
    for (_, label, _) in BD_METRICS {
        let _ = write!(md, " {label} |");
    }
    let _ = writeln!(md);
    let _ = write!(md, "| --- |");
    for _ in BD_METRICS {
        let _ = write!(md, " --- |");
    }
    let _ = writeln!(md);
    for comp in &competitors {
        let _ = write!(md, "| {comp} |");
        for (_, _, metric) in BD_METRICS {
            let (bd, n) = mean_bd(s, comp, *metric);
            let _ = write!(
                md,
                " {}{} |",
                fmt_bd(bd),
                if bd.is_some() {
                    format!(" ({n})")
                } else {
                    String::new()
                }
            );
        }
        let _ = writeln!(md);
    }
    let _ = writeln!(md);

    // BD-rate по клипам (основная метрика PSNR-ov + VMAF, если есть).
    for (mid, label, metric) in BD_METRICS {
        if *mid != "psnr_ov" && *mid != "vmaf" {
            continue;
        }
        let any = competitors
            .iter()
            .any(|c| clips(s).iter().any(|cl| bd_vs(s, cl, c, *metric).is_some()));
        if !any {
            continue;
        }
        let _ = writeln!(md, "## BD-rate по клипам — {label}\n");
        let _ = write!(md, "| Клип |");
        for comp in &competitors {
            let _ = write!(md, " vs {comp} |");
        }
        let _ = writeln!(md);
        let _ = write!(md, "| --- |");
        for _ in &competitors {
            let _ = write!(md, " --- |");
        }
        let _ = writeln!(md);
        for clip in clips(s) {
            let _ = write!(md, "| {clip} |");
            for comp in &competitors {
                let _ = write!(md, " {} |", fmt_bd(bd_vs(s, &clip, comp, *metric)));
            }
            let _ = writeln!(md);
        }
        let _ = writeln!(md);
    }

    // Скорость.
    let _ = writeln!(
        md,
        "## Скорость (геометрическое среднее по всем прогонам)\n"
    );
    let _ = writeln!(md, "| Кодек | encode, fps | decode, fps |");
    let _ = writeln!(md, "| --- | --- | --- |");
    for id in &codecs {
        let enc = geomean(s.runs.iter().filter(|r| &r.codec == id).map(|r| r.enc_fps));
        let dec = geomean(s.runs.iter().filter(|r| &r.codec == id).map(|r| r.dec_fps));
        let _ = writeln!(
            md,
            "| {id} | {} | {} |",
            enc.map_or("—".into(), |v| format!("{v:.1}")),
            dec.map_or("—".into(), |v| format!("{v:.1}")),
        );
    }
    let _ = writeln!(
        md,
        "\nЗамер — wall-time всего процесса (запуск + y4m-IO), одинаково для всех кодеков.\n"
    );

    // Детали по клипам.
    let _ = writeln!(md, "## Детали по клипам\n");
    for clip in clips(s) {
        let first = s.runs.iter().find(|r| r.clip == clip).expect("clip есть");
        let _ = writeln!(
            md,
            "### {clip} ({}x{}, {} кадров, класс {})\n",
            first.width, first.height, first.frames, first.class
        );
        let _ = writeln!(md, "![RD-кривая {clip}](plots/{clip}_psnr_y.svg)\n");
        if s.runs.iter().any(|r| r.clip == clip && r.vmaf.is_some()) {
            let _ = writeln!(md, "![VMAF {clip}](plots/{clip}_vmaf.svg)\n");
        }
        let _ = writeln!(
            md,
            "| Кодек | q | kbps | bpp | PSNR-Y | PSNR-ov | SSIM-Y | VMAF | enc fps | dec fps |"
        );
        let _ = writeln!(
            md,
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
        );
        for id in &codecs {
            for r in s.runs.iter().filter(|r| r.clip == clip && &r.codec == id) {
                let _ = writeln!(
                    md,
                    "| {id} | {} | {:.1} | {:.4} | {:.2} | {:.2} | {:.4} | {} | {:.1} | {:.1} |",
                    r.q,
                    r.kbps,
                    r.bpp,
                    r.psnr_y,
                    r.psnr_ov,
                    r.ssim_y,
                    r.vmaf.map_or("—".into(), |v| format!("{v:.1}")),
                    r.enc_fps,
                    r.dec_fps,
                );
            }
        }
        let _ = writeln!(md);
    }

    let _ = writeln!(md, "## Методика\n");
    let _ = writeln!(
        md,
        "- Все кодеки — внешние процессы: FRC-V через `frc-v` CLI, остальные через ffmpeg.\n\
         - Размер потока — elementary stream: у IVF/FRV вычтен оверхед контейнера (32 + 12·N байт), h264/hevc — сырые Annex B.\n\
         - PSNR/SSIM считаются одним и тем же кодом (`frc_v::metrics`) по y4m-парам: PSNR-ov = взвешенный SSE (4·Y+Cb+Cr)/6, SSIM — окна 8×8, шаг 4.\n\
         - VMAF — libvmaf (модель по умолчанию), harmonic pooling не используется (mean).\n\
         - BD-rate — PCHIP-интерполяция ln(rate) по метрике с интегрированием по общему интервалу качества (схема JVET/AOM CTC).\n\
         - Скорость — wall-time процесса; у всех энкодеров 1 поток, у декодеров тоже."
    );
    md
}

/// Короткая текстовая сводка в консоль после прогона.
pub fn summary_text(s: &Snapshot) -> String {
    let mut out = String::new();
    let codecs = snapshot_codecs(s);
    let _ = writeln!(
        out,
        "\n=== Сводка: BD-rate FRC-V против конкурентов (среднее по клипам) ==="
    );
    let _ = writeln!(
        out,
        "{:<10} {:>14} {:>14} {:>14} {:>14}",
        "конкурент", "PSNR-Y", "PSNR-ov", "SSIM-Y(dB)", "VMAF"
    );
    for comp in codecs.iter().filter(|c| c.as_str() != "frcv") {
        let cells: Vec<String> = BD_METRICS
            .iter()
            .map(|(_, _, m)| {
                let (bd, n) = mean_bd(s, comp, *m);
                match bd {
                    Some(v) => format!("{v:+.1}% ({n})"),
                    None => "—".into(),
                }
            })
            .collect();
        let _ = writeln!(
            out,
            "{:<10} {:>14} {:>14} {:>14} {:>14}",
            comp, cells[0], cells[1], cells[2], cells[3]
        );
    }
    let _ = writeln!(out, "минус = FRC-V экономит биты при том же качестве.");
    out
}

// ---------------------------------------------------------------------------
// Файлы отчёта
// ---------------------------------------------------------------------------

/// Пишет snapshot.json, report.md и RD-графики в `out_dir`.
pub fn write_all(out_dir: &Path, s: &Snapshot) -> io::Result<()> {
    fs::create_dir_all(out_dir.join("plots"))?;
    fs::write(
        out_dir.join("snapshot.json"),
        serde_json::to_string_pretty(s).expect("snapshot сериализуем"),
    )?;
    fs::write(out_dir.join("report.md"), report_markdown(s))?;

    for clip in clips(s) {
        for (mid, label, metric) in BD_METRICS {
            if *mid != "psnr_y" && *mid != "vmaf" {
                continue;
            }
            let mut series: Vec<Series> = Vec::new();
            for codec in snapshot_codecs(s) {
                if let Some(points) = rd_points(s, &clip, &codec, *metric) {
                    series.push(Series {
                        label: codec.clone(),
                        color: codec_color(&codec),
                        points,
                    });
                }
            }
            if series.len() < 2 {
                continue;
            }
            let chart = svg::rd_chart(&format!("{clip} — {label}"), "kbps (log)", label, &series);
            fs::write(out_dir.join(format!("plots/{clip}_{mid}.svg")), chart)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Сравнение снимков (прогресс FRC-V между версиями)
// ---------------------------------------------------------------------------

pub struct CompareTolerance {
    /// Допустимая деградация self-BD-rate на клипе, %.
    pub per_clip: f64,
    /// Допустимая средняя деградация, %.
    pub mean: f64,
}

impl Default for CompareTolerance {
    fn default() -> Self {
        CompareTolerance {
            per_clip: 2.0,
            mean: 0.5,
        }
    }
}

/// Сравнение прогресса FRC-V: BD-rate новых точек FRC-V против старых
/// (якорь — старый снимок) + дельты средних BD против конкурентов.
/// Возвращает (текст, список регрессий).
pub fn compare_text(
    old: &Snapshot,
    new: &Snapshot,
    tol: &CompareTolerance,
) -> (String, Vec<String>) {
    let mut out = String::new();
    let mut regressions = Vec::new();

    let _ = writeln!(
        out,
        "прогресс FRC-V: «{}» → «{}» (BD-rate нового против старого; минус = стало лучше)\n",
        old.label, new.label
    );
    let _ = writeln!(
        out,
        "{:<26} {:>10} {:>10} {:>10}",
        "клип", "PSNR-ov", "SSIM(dB)", "VMAF"
    );
    let mut self_bd_all: Vec<f64> = Vec::new();
    let common: Vec<String> = clips(new)
        .into_iter()
        .filter(|c| clips(old).contains(c))
        .collect();
    for clip in &common {
        let mut cells = Vec::new();
        for (mid, _, metric) in BD_METRICS {
            if *mid == "psnr_y" {
                continue;
            }
            let old_pts = rd_points(old, clip, "frcv", *metric);
            let new_pts = rd_points(new, clip, "frcv", *metric);
            let bd = match (old_pts, new_pts) {
                (Some(a), Some(t)) => bd_rate(&a, &t),
                _ => None,
            };
            if *mid == "psnr_ov"
                && let Some(v) = bd
            {
                self_bd_all.push(v);
                if v > tol.per_clip {
                    regressions.push(format!(
                        "{clip}: self-BD-rate {v:+.2}% (PSNR-ov) хуже допуска {:.1}%",
                        tol.per_clip
                    ));
                }
            }
            cells.push(fmt_bd(bd));
        }
        let _ = writeln!(
            out,
            "{:<26} {:>10} {:>10} {:>10}",
            clip, cells[0], cells[1], cells[2]
        );
    }
    if let Some(m) = mean(&self_bd_all) {
        let _ = writeln!(out, "\nсреднее по клипам (PSNR-ov): {m:+.2}%");
        if m > tol.mean {
            regressions.push(format!(
                "средний self-BD-rate {m:+.2}% хуже допуска {:+.1}%",
                tol.mean
            ));
        }
    }

    // Дельты против конкурентов.
    let comps: Vec<String> = snapshot_codecs(new)
        .into_iter()
        .filter(|c| c != "frcv" && snapshot_codecs(old).contains(c))
        .collect();
    if !comps.is_empty() {
        let _ = writeln!(
            out,
            "\nсредний BD-rate против конкурентов (PSNR-ov), старый → новый:"
        );
        for comp in comps {
            let metric = BD_METRICS[1].2;
            let (o, _) = mean_bd(old, &comp, metric);
            let (n, _) = mean_bd(new, &comp, metric);
            let _ = writeln!(out, "  vs {comp:<8} {} → {}", fmt_bd(o), fmt_bd(n));
        }
    }
    (out, regressions)
}
