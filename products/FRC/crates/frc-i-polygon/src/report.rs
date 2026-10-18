//! Отчёты арены: BD-rate сводки против якоря, markdown-отчёт с RD-таблицами
//! и графиками, короткая текстовая сводка и сравнение снимков (прогресс/
//! регрессии сторон FRC-I) со сторожевыми критериями линий: размер лестницы
//! (сдвиг рабочей точки q↔байты) и iso-size (дельта качества на ближайшем
//! размере, диагностика «выигрыш не куплен бюджетом», §11.8/§11.10 frc-i.md).

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::Path;

use crate::bd::bd_rate;
use crate::runner::{RunRecord, Snapshot};
use crate::svg::{self, Series};

/// Метрики BD-кривых: (id, подпись, извлечение). butteraugli берётся со
/// знаком минус, чтобы «больше = лучше» было единообразно.
type MetricFn = fn(&RunRecord) -> Option<f64>;
pub const BD_METRICS: &[(&str, &str, MetricFn)] = &[
    ("psnr_rgb", "PSNR-RGB", |r| Some(r.psnr_rgb)),
    ("psnr_y", "PSNR-Y", |r| Some(r.psnr_y)),
    ("ssim_db", "SSIM(dB)", |r| Some(r.ssim_db)),
    ("s2", "SSIMULACRA2", |r| r.s2),
    ("neg_ba", "BA(pnorm)", |r| r.ba.map(|v| -v)),
];

const PALETTE: &[&str] = &[
    "#e11d48", "#2563eb", "#7c3aed", "#059669", "#d97706", "#64748b", "#db2777", "#0891b2",
];

fn codec_color(idx: usize) -> &'static str {
    PALETTE[idx % PALETTE.len()]
}

/// Изображения снимка в порядке появления.
fn images(s: &Snapshot) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for r in &s.runs {
        if seen.insert(r.image.clone()) {
            out.push(r.image.clone());
        }
    }
    out
}

/// Участники снимка в порядке появления (стороны FRI идут первыми по
/// построению раннера).
fn codecs(s: &Snapshot) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for r in &s.runs {
        if seen.insert(r.codec.clone()) {
            out.push(r.codec.clone());
        }
    }
    out
}

/// Якорь BD-таблиц: сторона `fri`, иначе первый участник.
pub fn anchor(s: &Snapshot) -> String {
    codecs(s)
        .into_iter()
        .find(|c| c == "fri")
        .unwrap_or_else(|| codecs(s).remove(0))
}

/// RD-точки участника на изображении: (bpp, метрика). None, если метрика
/// отсутствует хотя бы в одной точке (например S2 не считался).
fn rd_points(s: &Snapshot, image: &str, codec: &str, metric: MetricFn) -> Option<Vec<(f64, f64)>> {
    let mut pts = Vec::new();
    for r in s
        .runs
        .iter()
        .filter(|r| r.image == image && r.codec == codec)
    {
        pts.push((r.bpp, metric(r)?));
    }
    (pts.len() >= 2).then_some(pts)
}

/// BD-rate теста против якоря на изображении по метрике.
pub fn bd_vs(s: &Snapshot, image: &str, test: &str, anchor: &str, metric: MetricFn) -> Option<f64> {
    if test == anchor {
        return None;
    }
    let a = rd_points(s, image, anchor, metric)?;
    let t = rd_points(s, image, test, metric)?;
    bd_rate(&a, &t)
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

/// Средний BD-rate теста против якоря по всем изображениям (и их число).
fn mean_bd(s: &Snapshot, test: &str, anchor: &str, metric: MetricFn) -> (Option<f64>, usize) {
    let vals: Vec<f64> = images(s)
        .iter()
        .filter_map(|c| bd_vs(s, c, test, anchor, metric))
        .collect();
    (mean(&vals), vals.len())
}

/// Классы корпуса в порядке появления.
fn classes(s: &Snapshot) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for r in &s.runs {
        if seen.insert(r.class.clone()) {
            out.push(r.class.clone());
        }
    }
    out
}

/// Средний BD-rate теста против якоря по классу.
fn class_bd(s: &Snapshot, class: &str, test: &str, anchor: &str, metric: MetricFn) -> Option<f64> {
    let vals: Vec<f64> = images(s)
        .iter()
        .filter(|img| s.runs.iter().any(|r| &r.image == *img && r.class == class))
        .filter_map(|c| bd_vs(s, c, test, anchor, metric))
        .collect();
    mean(&vals)
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
    let codecs = codecs(s);
    let anchor = anchor(s);
    let others: Vec<&String> = codecs.iter().filter(|c| **c != anchor).collect();

    let _ = writeln!(md, "# FRC-I polygon — отчёт арены\n");
    let _ = writeln!(
        md,
        "- Снимок: **{}** ({})",
        s.label,
        fmt_utc(s.created_unix)
    );
    let _ = writeln!(
        md,
        "- Инструменты: {}; flora: `{}`",
        s.tools.ffmpeg, s.tools.flora
    );
    let _ = writeln!(
        md,
        "- Внешние метрики: SSIMULACRA2 — {}, butteraugli — {}",
        s.tools.ssimulacra2, s.tools.butteraugli
    );
    let _ = writeln!(
        md,
        "- Условия: все участники — внешние процессы (spawn wall-time), повторов на точку: {}",
        s.config.repeat
    );
    let _ = writeln!(md, "- Участники (якорь: `{anchor}`):");
    for id in &codecs {
        let label = s.config.codec_labels.get(id).cloned().unwrap_or_default();
        let env_note = s
            .config
            .fri_envs
            .get(id)
            .filter(|e| !e.is_empty())
            .map(|e| format!(" — `{e}`"))
            .unwrap_or_default();
        let _ = writeln!(md, "  - `{id}` — {label}{env_note}");
    }
    let _ = writeln!(md);

    // Сводка BD-rate.
    let _ = writeln!(md, "## Сводка BD-rate (против якоря `{anchor}`)\n");
    let _ = writeln!(
        md,
        "Отрицательное значение — участнику нужно меньше бит на то же качество \
         (он лучше якоря). Среднее по изображениям, в скобках — число образов.\n"
    );
    let _ = write!(md, "| Участник |");
    for (_, label, _) in BD_METRICS {
        let _ = write!(md, " {label} |");
    }
    let _ = writeln!(md);
    let _ = write!(md, "| --- |");
    for _ in BD_METRICS {
        let _ = write!(md, " --- |");
    }
    let _ = writeln!(md);
    for test in &others {
        let _ = write!(md, "| {test} |");
        for (_, _, metric) in BD_METRICS {
            let (bd, n) = mean_bd(s, test, &anchor, *metric);
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

    // BD-rate по классам (основная пара метрик).
    for (mid, label, metric) in BD_METRICS {
        if *mid != "psnr_rgb" && *mid != "s2" {
            continue;
        }
        let any = others.iter().any(|t| {
            classes(s)
                .iter()
                .any(|cl| class_bd(s, cl, t, &anchor, *metric).is_some())
        });
        if !any {
            continue;
        }
        let _ = writeln!(md, "## BD-rate по классам — {label}\n");
        let _ = write!(md, "| Класс |");
        for test in &others {
            let _ = write!(md, " vs {test} |");
        }
        let _ = writeln!(md);
        let _ = write!(md, "| --- |");
        for _ in &others {
            let _ = write!(md, " --- |");
        }
        let _ = writeln!(md);
        for class in classes(s) {
            let _ = write!(md, "| {class} |");
            for test in &others {
                let _ = write!(
                    md,
                    " {} |",
                    fmt_bd(class_bd(s, &class, test, &anchor, *metric))
                );
            }
            let _ = writeln!(md);
        }
        let _ = writeln!(md);
    }

    // BD-rate по изображениям (гейт-метрики линий: PSNR-RGB, SSIMULACRA2,
    // butteraugli — по ним оценивается «ни одного кадра в регрессии», §11.10).
    for (mid, label, metric) in BD_METRICS {
        if *mid != "psnr_rgb" && *mid != "s2" && *mid != "neg_ba" {
            continue;
        }
        let any = others.iter().any(|t| {
            images(s)
                .iter()
                .any(|im| bd_vs(s, im, t, &anchor, *metric).is_some())
        });
        if !any {
            continue;
        }
        let _ = writeln!(md, "## BD-rate по изображениям — {label}\n");
        let _ = write!(md, "| Изображение |");
        for test in &others {
            let _ = write!(md, " vs {test} |");
        }
        let _ = writeln!(md);
        let _ = write!(md, "| --- |");
        for _ in &others {
            let _ = write!(md, " --- |");
        }
        let _ = writeln!(md);
        for image in images(s) {
            let _ = write!(md, "| {image} |");
            for test in &others {
                let _ = write!(
                    md,
                    " {} |",
                    fmt_bd(bd_vs(s, &image, test, &anchor, *metric))
                );
            }
            let _ = writeln!(md);
        }
        let _ = writeln!(md);
    }

    // Диагностика равного размера файла (frc-i.md §11.8, обязательна на
    // гейте линий): качество теста интерполируется по его лестнице на размер
    // каждой точки якоря; положительная дельта — выигрыш качества при равных
    // байтах, а не сдвиг рабочей точки. BA в единицах −pnorm (больше = лучше).
    {
        let gate: Vec<(&str, &str, MetricFn)> = BD_METRICS
            .iter()
            .filter(|(mid, _, _)| *mid == "psnr_rgb" || *mid == "s2" || *mid == "neg_ba")
            .map(|(mid, label, m)| (*mid, *label, *m))
            .collect();
        let mut wrote_header = false;
        for test in &others {
            let mut rows = Vec::new();
            for (mid, label, metric) in &gate {
                let mut deltas = Vec::new();
                for image in images(s) {
                    let (Some(a), Some(t)) = (
                        rd_points(s, &image, &anchor, *metric),
                        rd_points(s, &image, test, *metric),
                    ) else {
                        continue;
                    };
                    let _ = mid;
                    deltas.extend(crate::bd::iso_size_deltas(&a, &t));
                }
                if deltas.is_empty() {
                    continue;
                }
                let mean = deltas.iter().sum::<f64>() / deltas.len() as f64;
                let min = deltas.iter().copied().fold(f64::INFINITY, f64::min);
                rows.push(format!(
                    "| {test} | {label} | {mean:+.3} | {min:+.3} | {} |",
                    deltas.len()
                ));
            }
            if !rows.is_empty() {
                if !wrote_header {
                    let _ = writeln!(md, "## Диагностика равного размера файла (§11.8)\n");
                    let _ = writeln!(
                        md,
                        "Качество теста интерполировано по его лестнице на размер каждой \
                         точки якоря; положительное = тест лучше при равных байтах. \
                         BA — в единицах −pnorm.\n"
                    );
                    let _ = writeln!(md, "| Участник | Метрика | Средний Δ | Мин Δ | Точек |");
                    let _ = writeln!(md, "| --- | --- | --- | --- | --- |");
                    wrote_header = true;
                }
                for row in rows {
                    let _ = writeln!(md, "{row}");
                }
            }
        }
        if wrote_header {
            let _ = writeln!(md);
        }
    }

    // Скорость.
    let _ = writeln!(md, "## Скорость (геометрическое среднее, Мп/с)\n");
    let _ = writeln!(md, "| Участник | encode | decode |");
    let _ = writeln!(md, "| --- | --- | --- |");
    for id in &codecs {
        let enc = geomean(
            s.runs
                .iter()
                .filter(|r| &r.codec == id)
                .map(|r| f64::from(r.width) * f64::from(r.height) / (r.enc_ms / 1000.0) / 1e6),
        );
        let dec = geomean(
            s.runs
                .iter()
                .filter(|r| &r.codec == id)
                .map(|r| f64::from(r.width) * f64::from(r.height) / (r.dec_ms / 1000.0) / 1e6),
        );
        let _ = writeln!(
            md,
            "| {id} | {} | {} |",
            enc.map_or("—".into(), |v| format!("{v:.1}")),
            dec.map_or("—".into(), |v| format!("{v:.1}")),
        );
    }
    let _ = writeln!(
        md,
        "\nЗамер — медиана wall-time процесса (spawn + PNG-IO), одинаково для всех участников.\n"
    );

    // Детали по изображениям.
    let _ = writeln!(md, "## Детали по изображениям\n");
    for image in images(s) {
        let first = s
            .runs
            .iter()
            .find(|r| r.image == image)
            .expect("образ есть");
        let _ = writeln!(
            md,
            "### {image} ({}x{}, класс {})\n",
            first.width, first.height, first.class
        );
        let _ = writeln!(md, "![RD-кривая {image}](plots/{image}_psnr_rgb.svg)\n");
        if s.runs.iter().any(|r| r.image == image && r.s2.is_some()) {
            let _ = writeln!(md, "![SSIMULACRA2 {image}](plots/{image}_s2.svg)\n");
        }
        let _ = writeln!(
            md,
            "| Участник | q | байты | bpp | PSNR-RGB | PSNR-Y | SSIM(dB) | S2 | BA | enc ms | dec ms |"
        );
        let _ = writeln!(
            md,
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
        );
        for id in &codecs {
            for r in s.runs.iter().filter(|r| r.image == image && &r.codec == id) {
                let _ = writeln!(
                    md,
                    "| {id} | {} | {} | {:.4} | {:.2} | {:.2} | {:.2} | {} | {} | {:.1} | {:.1} |",
                    r.q,
                    r.payload_bytes,
                    r.bpp,
                    r.psnr_rgb,
                    r.psnr_y,
                    r.ssim_db,
                    r.s2.map_or("—".into(), |v| format!("{v:.2}")),
                    r.ba.map_or("—".into(), |v| format!("{v:.3}")),
                    r.enc_ms,
                    r.dec_ms,
                );
            }
        }
        let _ = writeln!(md);
    }

    let _ = writeln!(md, "## Методика\n");
    let _ = writeln!(
        md,
        "- Все участники — внешние процессы: стороны FRC-I через `flora-codec` (env-ручки \
         передаются процессу), JPEG/WebP/AVIF через ffmpeg, JXL — нативными cjxl/djxl.\n\
         - Размер — полный файл битстрима: FRI — сырой поток, JPEG — файл JPEG, WebP — RIFF, \
         AVIF — BMFF-контейнер (включает контейнерный оверхед, зафиксировано как известное \
         смещение против AVIF на малых файлах).\n\
         - PSNR (RGB и Y BT.709) и SSIM (окна 8×8, шаг 4 → −10·log10(1−x)) считаются одним \
         кодом `frc-i-polygon` по PNG-парам; SSIMULACRA2 и butteraugli pnorm — бинарями \
         libjxl; BD по butteraugli считается по −pnorm.\n\
         - BD-rate — PCHIP-интерполяция ln(bpp) по метрике с интегрированием по общему \
         интервалу качества (схема JVET/AOM CTC).\n\
         - AVIF: libaom-av1 `-still-picture 1 -pix_fmt yuv420p` (4:2:0 — как рабочая зона \
         FRI q≤85 и JPEG по умолчанию).\n\
         - Скорость — медиана wall-time процесса; threading участников по умолчанию \
         (FRI — тайловый параллелизм), как в исторической арене линий v9–v12."
    );
    md
}

/// Короткая текстовая сводка в консоль после прогона.
pub fn summary_text(s: &Snapshot) -> String {
    let mut out = String::new();
    let anchor = anchor(s);
    let _ = writeln!(
        out,
        "\n=== Сводка: BD-rate против якоря `{anchor}` (среднее по изображениям) ==="
    );
    let _ = writeln!(
        out,
        "{:<10} {:>12} {:>12} {:>12} {:>12} {:>12}",
        "участник", "PSNR-RGB", "PSNR-Y", "SSIM(dB)", "S2", "BA(pnorm)"
    );
    for test in codecs(s).iter().filter(|c| **c != anchor) {
        let cells: Vec<String> = BD_METRICS
            .iter()
            .map(|(_, _, m)| {
                let (bd, n) = mean_bd(s, test, &anchor, *m);
                match bd {
                    Some(v) => format!("{v:+.1}% ({n})"),
                    None => "—".into(),
                }
            })
            .collect();
        let _ = writeln!(
            out,
            "{:<10} {:>12} {:>12} {:>12} {:>12} {:>12}",
            test, cells[0], cells[1], cells[2], cells[3], cells[4]
        );
    }
    let _ = writeln!(out, "минус = участник экономит биты при том же качестве.");
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

    for image in images(s) {
        for (mid, label, metric) in BD_METRICS {
            if *mid != "psnr_rgb" && *mid != "s2" {
                continue;
            }
            let mut series: Vec<Series> = Vec::new();
            for (idx, codec) in codecs(s).iter().enumerate() {
                if let Some(points) = rd_points(s, &image, codec, *metric) {
                    series.push(Series {
                        label: codec.clone(),
                        color: codec_color(idx),
                        points,
                    });
                }
            }
            if series.len() < 2 {
                continue;
            }
            let chart = svg::rd_chart(&format!("{image} — {label}"), "bpp (log)", label, &series);
            fs::write(out_dir.join(format!("plots/{image}_{mid}.svg")), chart)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Сравнение снимков (прогресс/регрессии сторон между прогонами)
// ---------------------------------------------------------------------------

pub struct CompareTolerance {
    /// Допустимая деградация BD-rate на изображении (гейт-метрика), %.
    pub per_image: f64,
    /// Допустимая средняя деградация, %.
    pub mean: f64,
    /// Допустимый сдвиг размера лестницы (|Σnew/Σold − 1|), доля.
    pub ladder: f64,
}

impl Default for CompareTolerance {
    fn default() -> Self {
        CompareTolerance {
            per_image: 2.0,
            mean: 0.5,
            ladder: 0.02,
        }
    }
}

/// Общие (image, codec, q) точки двух снимков для размера лестницы.
fn ladder_ratio(old: &Snapshot, new: &Snapshot, codec: &str) -> Option<f64> {
    let mut sum_old = 0u64;
    let mut sum_new = 0u64;
    for rn in new.runs.iter().filter(|r| r.codec == codec) {
        if let Some(ro) = old
            .runs
            .iter()
            .find(|r| r.codec == codec && r.image == rn.image && r.q == rn.q)
        {
            sum_old += ro.payload_bytes;
            sum_new += rn.payload_bytes;
        }
    }
    (sum_old > 0).then(|| sum_new as f64 / sum_old as f64)
}

/// Iso-size сводка: дельты качества на ближайшем размере (±12%),
/// положительные = новый лучше.
struct IsoSize {
    matches: usize,
    d_s2: Option<f64>,
    d_ba: Option<f64>,
    d_psnr: Option<f64>,
}

/// Iso-size: для каждой точки нового снимка ищется точка старого с тем же
/// участником и изображением и ближайшим размером в пределах ±12%.
fn iso_size(old: &Snapshot, new: &Snapshot, codec: &str) -> Option<IsoSize> {
    let (mut n, mut ds2, mut dba, mut dpsnr) = (0usize, Vec::new(), Vec::new(), Vec::new());
    for rn in new.runs.iter().filter(|r| r.codec == codec) {
        let candidates = old
            .runs
            .iter()
            .filter(|r| r.codec == codec && r.image == rn.image);
        let mut best: Option<&RunRecord> = None;
        for ro in candidates {
            let err = (ro.payload_bytes as f64 - rn.payload_bytes as f64).abs()
                / rn.payload_bytes.max(1) as f64;
            if err <= 0.12
                && best.is_none_or(|b| {
                    (b.payload_bytes as f64 - rn.payload_bytes as f64).abs()
                        > (ro.payload_bytes as f64 - rn.payload_bytes as f64).abs()
                })
            {
                best = Some(ro);
            }
        }
        let Some(ro) = best else { continue };
        n += 1;
        if let (Some(a), Some(b)) = (rn.s2, ro.s2) {
            ds2.push(a - b);
        }
        if let (Some(a), Some(b)) = (rn.ba, ro.ba) {
            dba.push(b - a); // ниже BA = лучше → старый минус новый
        }
        dpsnr.push(rn.psnr_rgb - ro.psnr_rgb);
    }
    (n > 0).then(|| IsoSize {
        matches: n,
        d_s2: mean(&ds2),
        d_ba: mean(&dba),
        d_psnr: mean(&dpsnr),
    })
}

/// Гейт-метрика сравнения: S2, если она есть у обоих снимков для этого
/// участника, иначе PSNR-RGB.
fn gate_metric<'a>(old: &Snapshot, new: &Snapshot, codec: &str) -> (&'a str, MetricFn) {
    let has_s2 = |s: &Snapshot| s.runs.iter().any(|r| r.codec == codec && r.s2.is_some());
    if has_s2(old) && has_s2(new) {
        ("s2", BD_METRICS[3].2)
    } else {
        ("psnr_rgb", BD_METRICS[0].2)
    }
}

/// Сравнение двух снимков по общим участникам: BD-rate новых точек против
/// старых (якорь — старый снимок; минус = стало лучше), размер лестницы,
/// iso-size. Возвращает (текст, список регрессий).
pub fn compare_text(
    old: &Snapshot,
    new: &Snapshot,
    tol: &CompareTolerance,
) -> (String, Vec<String>) {
    let mut out = String::new();
    let mut regressions = Vec::new();

    let common_codecs: Vec<String> = codecs(new)
        .into_iter()
        .filter(|c| codecs(old).contains(c))
        .collect();
    if common_codecs.is_empty() {
        return ("нет общих участников между снимками".into(), regressions);
    }

    let _ = writeln!(
        out,
        "сравнение: «{}» → «{}» (BD нового против старого; минус = стало лучше)\n",
        old.label, new.label
    );

    for codec in &common_codecs {
        let (gate_id, _) = gate_metric(old, new, codec);
        let common_images: Vec<String> = images(new)
            .into_iter()
            .filter(|c| images(old).contains(c))
            .collect();
        let _ = writeln!(
            out,
            "—— {codec} (гейт-метрика: {gate_id}) ——\n{:<26} {:>10} {:>10} {:>10}",
            "изображение", "PSNR-RGB", "S2", "BA"
        );
        let mut gate_all: Vec<f64> = Vec::new();
        for image in &common_images {
            let mut cells = Vec::new();
            for (mid, _, metric) in BD_METRICS {
                if *mid != "psnr_rgb" && *mid != "s2" && *mid != "neg_ba" {
                    continue;
                }
                let old_pts = rd_points(old, image, codec, *metric);
                let new_pts = rd_points(new, image, codec, *metric);
                let bd = match (old_pts, new_pts) {
                    (Some(a), Some(t)) => bd_rate(&a, &t),
                    _ => None,
                };
                if *mid == gate_id
                    && let Some(v) = bd
                {
                    gate_all.push(v);
                    if v > tol.per_image {
                        regressions.push(format!(
                            "{codec}/{image}: self-BD {v:+.2}% ({gate_id}) хуже допуска {:.1}%",
                            tol.per_image
                        ));
                    }
                }
                cells.push(fmt_bd(bd));
            }
            let _ = writeln!(
                out,
                "{:<26} {:>10} {:>10} {:>10}",
                image, cells[0], cells[1], cells[2]
            );
        }
        if let Some(m) = mean(&gate_all) {
            let _ = writeln!(out, "  среднее ({gate_id}): {m:+.2}%");
            if m > tol.mean {
                regressions.push(format!(
                    "{codec}: средний self-BD {m:+.2}% хуже допуска {:+.1}%",
                    tol.mean
                ));
            }
        }
        if let Some(ratio) = ladder_ratio(old, new, codec) {
            let _ = writeln!(out, "  размер лестницы (Σnew/Σold): {ratio:.4}");
            if (ratio - 1.0).abs() > tol.ladder {
                regressions.push(format!(
                    "{codec}: лестница {ratio:.4} вне допуска ±{:.2} (сдвиг рабочей точки)",
                    tol.ladder
                ));
            }
        }
        if let Some(iso) = iso_size(old, new, codec) {
            let _ = writeln!(
                out,
                "  iso-size ({} пар, ±12%): ΔS2 {} | ΔBA {} | ΔPSNR {}",
                iso.matches,
                iso.d_s2.map_or("—".into(), |v| format!("{v:+.2}")),
                iso.d_ba.map_or("—".into(), |v| format!("{v:+.3}")),
                iso.d_psnr.map_or("—".into(), |v| format!("{v:+.2} dB")),
            );
        }
        let _ = writeln!(out);
    }
    (out, regressions)
}
