//! RD-графики в самодостаточном SVG (без зависимостей): ось X — битрейт в
//! логарифмическом масштабе, ось Y — метрика качества; серия на кодек.

use std::fmt::Write as _;

pub struct Series {
    pub label: String,
    pub color: &'static str,
    /// (kbps, метрика).
    pub points: Vec<(f64, f64)>,
}

const W: f64 = 780.0;
const H: f64 = 480.0;
const ML: f64 = 62.0; // поля: слева/справа/сверху/снизу
const MR: f64 = 18.0;
const MT: f64 = 34.0;
const MB: f64 = 46.0;

/// «Красивые» тики линейной оси: шаг 1/2/5·10^k, ≈ target делений.
fn linear_ticks(lo: f64, hi: f64, target: usize) -> Vec<f64> {
    let span = (hi - lo).max(1e-12);
    let raw = span / target as f64;
    let mag = 10f64.powf(raw.log10().floor());
    let step = [1.0, 2.0, 5.0, 10.0]
        .iter()
        .map(|m| m * mag)
        .find(|s| span / s <= target as f64 * 1.2)
        .unwrap_or(10.0 * mag);
    let mut t = (lo / step).ceil() * step;
    let mut out = Vec::new();
    while t <= hi + 1e-9 {
        out.push(t);
        t += step;
    }
    out
}

/// Тики логарифмической оси: 1/2/5·10^k в диапазоне.
fn log_ticks(lo: f64, hi: f64) -> Vec<f64> {
    let mut out = Vec::new();
    let mut mag = 10f64.powf(lo.log10().floor());
    while mag <= hi {
        for m in [1.0, 2.0, 5.0] {
            let v = m * mag;
            if v >= lo * 0.999 && v <= hi * 1.001 {
                out.push(v);
            }
        }
        mag *= 10.0;
    }
    // Прореживание, если тиков слишком много.
    while out.len() > 9 {
        out = out.iter().copied().step_by(2).collect();
    }
    out
}

fn fmt_tick(v: f64) -> String {
    if v >= 1000.0 {
        format!("{:.0}k", v / 1000.0)
    } else if v >= 10.0 {
        format!("{v:.0}")
    } else {
        format!("{v:.1}")
    }
}

/// Строит RD-график. Требует ≥1 серии с ≥2 точками.
pub fn rd_chart(title: &str, x_label: &str, y_label: &str, series: &[Series]) -> String {
    let mut xs: Vec<f64> = Vec::new();
    let mut ys: Vec<f64> = Vec::new();
    for s in series {
        for &(x, y) in &s.points {
            if x > 0.0 && y.is_finite() {
                xs.push(x);
                ys.push(y);
            }
        }
    }
    let (x_lo, x_hi) = (
        xs.iter().copied().fold(f64::INFINITY, f64::min) * 0.9,
        xs.iter().copied().fold(0.0, f64::max) * 1.1,
    );
    let y_min = ys.iter().copied().fold(f64::INFINITY, f64::min);
    let y_max = ys.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let pad = ((y_max - y_min) * 0.08).max(0.2);
    let (y_lo, y_hi) = (y_min - pad, y_max + pad);

    let px = |x: f64| ML + (x.ln() - x_lo.ln()) / (x_hi.ln() - x_lo.ln()) * (W - ML - MR);
    let py = |y: f64| H - MB - (y - y_lo) / (y_hi - y_lo) * (H - MT - MB);

    let mut svg = String::new();
    let _ = writeln!(
        svg,
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="system-ui, sans-serif">"##
    );
    let _ = writeln!(svg, r##"<rect width="{W}" height="{H}" fill="#ffffff"/>"##);
    let _ = writeln!(
        svg,
        r##"<text x="{}" y="20" font-size="14" font-weight="600" fill="#111827">{}</text>"##,
        ML,
        xml_escape(title)
    );

    // Сетка и тики.
    for t in log_ticks(x_lo, x_hi) {
        let x = px(t);
        let _ = writeln!(
            svg,
            r##"<line x1="{x:.1}" y1="{MT}" x2="{x:.1}" y2="{:.1}" stroke="#e5e7eb" stroke-width="1"/>"##,
            H - MB
        );
        let _ = writeln!(
            svg,
            r##"<text x="{x:.1}" y="{:.1}" font-size="11" fill="#6b7280" text-anchor="middle">{}</text>"##,
            H - MB + 16.0,
            fmt_tick(t)
        );
    }
    for t in linear_ticks(y_lo, y_hi, 6) {
        let y = py(t);
        let _ = writeln!(
            svg,
            r##"<line x1="{ML}" y1="{y:.1}" x2="{:.1}" y2="{y:.1}" stroke="#e5e7eb" stroke-width="1"/>"##,
            W - MR
        );
        let _ = writeln!(
            svg,
            r##"<text x="{:.1}" y="{:.1}" font-size="11" fill="#6b7280" text-anchor="end">{}</text>"##,
            ML - 8.0,
            y + 4.0,
            fmt_tick(t)
        );
    }
    // Рамка и подписи осей.
    let _ = writeln!(
        svg,
        r##"<rect x="{ML}" y="{MT}" width="{:.1}" height="{:.1}" fill="none" stroke="#9ca3af" stroke-width="1"/>"##,
        W - ML - MR,
        H - MT - MB
    );
    let _ = writeln!(
        svg,
        r##"<text x="{:.1}" y="{:.1}" font-size="12" fill="#374151" text-anchor="middle">{}</text>"##,
        ML + (W - ML - MR) / 2.0,
        H - 10.0,
        xml_escape(x_label)
    );
    let _ = writeln!(
        svg,
        r##"<text x="14" y="{:.1}" font-size="12" fill="#374151" text-anchor="middle" transform="rotate(-90 14 {:.1})">{}</text>"##,
        MT + (H - MT - MB) / 2.0,
        MT + (H - MT - MB) / 2.0,
        xml_escape(y_label)
    );

    // Серии.
    for s in series {
        let mut pts: Vec<(f64, f64)> = s
            .points
            .iter()
            .copied()
            .filter(|&(x, y)| x > 0.0 && y.is_finite())
            .collect();
        pts.sort_by(|a, b| a.0.total_cmp(&b.0));
        let path: Vec<String> = pts
            .iter()
            .map(|&(x, y)| format!("{:.1},{:.1}", px(x), py(y)))
            .collect();
        let _ = writeln!(
            svg,
            r##"<polyline points="{}" fill="none" stroke="{}" stroke-width="2"/>"##,
            path.join(" "),
            s.color
        );
        for &(x, y) in &pts {
            let _ = writeln!(
                svg,
                r##"<circle cx="{:.1}" cy="{:.1}" r="3.2" fill="{}"/>"##,
                px(x),
                py(y),
                s.color
            );
        }
    }

    // Легенда (правый нижний угол области — RD-кривые растут влево-вверх).
    let lx = W - MR - 150.0;
    let mut ly = H - MB - 16.0 * series.len() as f64 - 10.0;
    for s in series {
        let _ = writeln!(
            svg,
            r##"<line x1="{lx}" y1="{ly:.1}" x2="{:.1}" y2="{ly:.1}" stroke="{}" stroke-width="3"/>"##,
            lx + 22.0,
            s.color
        );
        let _ = writeln!(
            svg,
            r##"<text x="{:.1}" y="{:.1}" font-size="12" fill="#111827">{}</text>"##,
            lx + 28.0,
            ly + 4.0,
            xml_escape(&s.label)
        );
        ly += 16.0;
    }
    svg.push_str("</svg>\n");
    svg
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
