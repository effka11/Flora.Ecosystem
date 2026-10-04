//! BD-rate (Bjøntegaard delta rate) по современной схеме JVET/AOM:
//! PCHIP-интерполяция log-rate как функции метрики (монотонные кубики
//! Фритча–Карлсона) и точное интегрирование кусочных полиномов по общему
//! интервалу качества.
//!
//! Отрицательный BD-rate теста против якоря = тесту нужно меньше бит на то же
//! качество (тест лучше).

/// Кусочно-кубический монотонный интерполянт (PCHIP).
struct Pchip {
    x: Vec<f64>,
    y: Vec<f64>,
    /// Производные в узлах (Фритч–Карлсон).
    m: Vec<f64>,
}

impl Pchip {
    /// Строит интерполянт по строго возрастающим `x` (len >= 2).
    fn new(x: Vec<f64>, y: Vec<f64>) -> Pchip {
        let n = x.len();
        debug_assert!(n >= 2);
        let h: Vec<f64> = (0..n - 1).map(|i| x[i + 1] - x[i]).collect();
        let d: Vec<f64> = (0..n - 1).map(|i| (y[i + 1] - y[i]) / h[i]).collect();
        let mut m = vec![0.0; n];
        m[0] = d[0];
        m[n - 1] = d[n - 2];
        for i in 1..n - 1 {
            if d[i - 1] * d[i] <= 0.0 {
                m[i] = 0.0;
            } else {
                // Взвешенное гармоническое среднее соседних наклонов.
                let w1 = 2.0 * h[i] + h[i - 1];
                let w2 = h[i] + 2.0 * h[i - 1];
                m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
            }
        }
        // Ограничение Фритча–Карлсона на монотонность сегментов.
        for i in 0..n - 1 {
            if d[i] == 0.0 {
                m[i] = 0.0;
                m[i + 1] = 0.0;
            } else {
                let a = m[i] / d[i];
                let b = m[i + 1] / d[i];
                let s = a * a + b * b;
                if s > 9.0 {
                    let t = 3.0 / s.sqrt();
                    m[i] = t * a * d[i];
                    m[i + 1] = t * b * d[i];
                }
            }
        }
        Pchip { x, y, m }
    }

    fn eval(&self, xq: f64) -> f64 {
        let n = self.x.len();
        // Клампим в границы (вызовы всегда внутри общего интервала).
        if xq <= self.x[0] {
            return self.y[0];
        }
        if xq >= self.x[n - 1] {
            return self.y[n - 1];
        }
        let mut i = 0;
        while i + 2 < n && self.x[i + 1] < xq {
            i += 1;
        }
        let h = self.x[i + 1] - self.x[i];
        let t = (xq - self.x[i]) / h;
        let (t2, t3) = (t * t, t * t * t);
        let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
        let h10 = t3 - 2.0 * t2 + t;
        let h01 = -2.0 * t3 + 3.0 * t2;
        let h11 = t3 - t2;
        h00 * self.y[i] + h10 * h * self.m[i] + h01 * self.y[i + 1] + h11 * h * self.m[i + 1]
    }

    /// ∫ f dx на [lo, hi] (Симпсон по равномерной сетке; кубики он берёт почти
    /// точно, узлы сетки не обязаны совпадать с узлами интерполянта).
    fn integrate(&self, lo: f64, hi: f64) -> f64 {
        const STEPS: usize = 256; // чётное
        let h = (hi - lo) / STEPS as f64;
        let mut acc = self.eval(lo) + self.eval(hi);
        for k in 1..STEPS {
            let x = lo + h * k as f64;
            acc += self.eval(x) * if k % 2 == 1 { 4.0 } else { 2.0 };
        }
        acc * h / 3.0
    }
}

/// Готовит кривую: сортировка по метрике, отбрасывание немонотонных дублей,
/// перевод rate в ln.
fn curve(points: &[(f64, f64)]) -> Option<Pchip> {
    let mut pts: Vec<(f64, f64)> = points
        .iter()
        .filter(|(r, m)| *r > 0.0 && m.is_finite())
        .map(|&(r, m)| (m, r.ln()))
        .collect();
    pts.sort_by(|a, b| a.0.total_cmp(&b.0));
    // Строго возрастающая метрика (дубли качества ломают интерполяцию).
    let mut dedup: Vec<(f64, f64)> = Vec::with_capacity(pts.len());
    for p in pts {
        match dedup.last() {
            Some(last) if p.0 - last.0 < 1e-9 => {}
            _ => dedup.push(p),
        }
    }
    if dedup.len() < 2 {
        return None;
    }
    let (x, y): (Vec<f64>, Vec<f64>) = dedup.into_iter().unzip();
    Some(Pchip::new(x, y))
}

/// BD-rate теста против якоря, в процентах. Точки — `(rate, metric)`,
/// rate в любых согласованных единицах (kbps/bpp), metric — PSNR/SSIM/VMAF.
/// `None` — кривые не пересекаются по качеству или точек мало.
pub fn bd_rate(anchor: &[(f64, f64)], test: &[(f64, f64)]) -> Option<f64> {
    let ca = curve(anchor)?;
    let ct = curve(test)?;
    let lo = ca.x[0].max(ct.x[0]);
    let hi = ca.x[ca.x.len() - 1].min(ct.x[ct.x.len() - 1]);
    if hi - lo < 1e-6 {
        return None;
    }
    let avg = (ct.integrate(lo, hi) - ca.integrate(lo, hi)) / (hi - lo);
    Some((avg.exp() - 1.0) * 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn curve_pts(rates: &[f64], metrics: &[f64]) -> Vec<(f64, f64)> {
        rates.iter().copied().zip(metrics.iter().copied()).collect()
    }

    #[test]
    fn identical_curves_zero() {
        let a = curve_pts(&[100.0, 200.0, 400.0, 800.0], &[30.0, 33.0, 36.0, 39.0]);
        let bd = bd_rate(&a, &a).unwrap();
        assert!(bd.abs() < 1e-9, "bd = {bd}");
    }

    #[test]
    fn uniform_rate_shift() {
        let a = curve_pts(&[100.0, 200.0, 400.0, 800.0], &[30.0, 33.0, 36.0, 39.0]);
        let b: Vec<(f64, f64)> = a.iter().map(|&(r, m)| (r * 1.10, m)).collect();
        let bd = bd_rate(&a, &b).unwrap();
        assert!((bd - 10.0).abs() < 1e-6, "bd = {bd}");
        let bd_rev = bd_rate(&b, &a).unwrap();
        assert!(
            (bd_rev - (1.0 / 1.10 - 1.0) * 100.0).abs() < 1e-6,
            "{bd_rev}"
        );
    }

    #[test]
    fn better_quality_negative() {
        // Тест даёт +1 dB на каждой ставке → BD-rate < 0.
        let a = curve_pts(&[100.0, 200.0, 400.0, 800.0], &[30.0, 33.0, 36.0, 39.0]);
        let b = curve_pts(&[100.0, 200.0, 400.0, 800.0], &[31.0, 34.0, 37.0, 40.0]);
        let bd = bd_rate(&a, &b).unwrap();
        assert!(bd < -15.0 && bd > -35.0, "bd = {bd}");
    }

    #[test]
    fn no_overlap_none() {
        let a = curve_pts(&[100.0, 200.0], &[30.0, 32.0]);
        let b = curve_pts(&[100.0, 200.0], &[40.0, 42.0]);
        assert!(bd_rate(&a, &b).is_none());
    }

    #[test]
    fn unsorted_input_ok() {
        let a = curve_pts(&[800.0, 100.0, 400.0, 200.0], &[39.0, 30.0, 36.0, 33.0]);
        let b: Vec<(f64, f64)> = a.iter().map(|&(r, m)| (r * 1.05, m)).collect();
        let bd = bd_rate(&a, &b).unwrap();
        assert!((bd - 5.0).abs() < 1e-6, "bd = {bd}");
    }
}
