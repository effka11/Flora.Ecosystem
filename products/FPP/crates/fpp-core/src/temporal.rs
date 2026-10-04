//! NS-T1 / NS-T2 — темпоральные метрики натуральности (FPP-SIGNALS §2).
//!
//! Считаются **на устройстве** по локальным событиям; наружу уходят только
//! квантованные bucket'ы (FPP-SIGNALS §3). Сервер применяет те же функции
//! к собственным наблюдениям класса A (например, к временам деклараций слотов).
//!
//! Метрики нормированы **формой, не объёмом** (анти-дискриминационный инвариант
//! FPP-SIGNALS §6): при выборке ниже минимальной сигнал отсутствует (`None`),
//! а отсутствие сигнала нейтрально — не штраф.

/// Минимум межсобытийных интервалов для NS-T1; ниже — `None`.
pub const MIN_INTERVALS: usize = 8;

/// Минимум событий суточного профиля для NS-T2; ниже — `None`.
pub const MIN_PROFILE_EVENTS: u64 = 24;

/// Зажим одного интервала: 10 лет в секундах. Ограничивает разрядность
/// промежуточных вычислений (переполнение исключается по построению).
pub const MAX_INTERVAL_S: u64 = 315_360_000;

/// Длина «окна отдыха» суточного профиля (часов подряд), NS-T2a.
pub const REST_WINDOW_HOURS: usize = 6;

const MICRO: u128 = 1_000_000;

/// NS-T1: burstiness Гоха–Барабаши `B = (σ − μ) / (σ + μ)` в промилле `[-1000, 1000]`.
///
/// Человеческая активность bursty (`B > 0`); расписания и cron-подобная автоматика
/// регулярны (`B → −1000`); пуассоновский случайный поток ≈ 0. Интервалы — в секундах,
/// каждый зажимается [`MAX_INTERVAL_S`]. σ и μ считаются в микромасштабе (×10⁶),
/// σ — целочисленный floor-корень дисперсии; деление — усечение к нулю.
/// Вырожденный случай `σ + μ = 0` (все интервалы нулевые — одновременные события)
/// определён как `−1000`: идеальная регулярность.
pub fn burstiness_permille(intervals_s: &[u64]) -> Option<i32> {
    if intervals_s.len() < MIN_INTERVALS {
        return None;
    }
    let n = intervals_s.len() as u128;
    let clamped = intervals_s.iter().map(|&x| x.min(MAX_INTERVAL_S) as u128);
    let sum: u128 = clamped.clone().sum();
    let mean_micro = sum * MICRO / n;
    let var_micro2: u128 = clamped
        .map(|x| {
            let d = (x * MICRO).abs_diff(mean_micro);
            d * d
        })
        .sum::<u128>()
        / n;
    let sigma_micro = var_micro2.isqrt();
    let denom = sigma_micro + mean_micro;
    if denom == 0 {
        return Some(-1000);
    }
    let num = sigma_micro as i128 - mean_micro as i128;
    Some((num * 1000 / denom as i128) as i32)
}

/// Суточная гистограмма активности: 24 часовых счётчика (локальное время устройства).
///
/// Сырая гистограмма **не покидает устройство** (FPP-SIGNALS §3) — наружу уходят
/// только производные bucket'ы от метрик ниже.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HourHistogram {
    pub counts: [u64; 24],
}

impl HourHistogram {
    pub const fn new(counts: [u64; 24]) -> HourHistogram {
        HourHistogram { counts }
    }

    /// Суммарное число событий профиля.
    pub fn total(&self) -> u128 {
        self.counts.iter().map(|&c| c as u128).sum()
    }

    /// NS-T2a: доля активности в самом тихом циклическом окне из
    /// [`REST_WINDOW_HOURS`] часов, ‰ от общего объёма.
    ///
    /// У человека существует окно сна: значение мало (обычно < 50‰).
    /// Круглосуточная автоматика даёт ≈ 250‰ (равномерность); по принципу Дирихле
    /// значение не превышает 250‰. `None` при выборке < [`MIN_PROFILE_EVENTS`].
    pub fn rest_share_permille(&self) -> Option<u32> {
        let total = self.total();
        if total < MIN_PROFILE_EVENTS as u128 {
            return None;
        }
        let min_window: u128 = (0..24)
            .map(|start| {
                (0..REST_WINDOW_HOURS)
                    .map(|i| self.counts[(start + i) % 24] as u128)
                    .sum()
            })
            .min()
            .expect("24 окна");
        Some((min_window * 1000 / total) as u32)
    }

    /// NS-T2b: доля пикового часа, ‰ от общего объёма.
    ///
    /// Экстремумы неестественны с обеих сторон: ≈ 42‰ — идеальная равномерность
    /// (машина), ≈ 1000‰ — вся активность в один час (cron). Человеческий пик
    /// обычно 80–250‰. `None` при выборке < [`MIN_PROFILE_EVENTS`].
    pub fn peak_share_permille(&self) -> Option<u32> {
        let total = self.total();
        if total < MIN_PROFILE_EVENTS as u128 {
            return None;
        }
        let max_hour = self.counts.iter().copied().max().expect("24 часа") as u128;
        Some((max_hour * 1000 / total) as u32)
    }

    /// NS-T2c: сходство двух профилей (например, эпоха-к-эпохе) —
    /// пересечение гистограмм с симметричной нормировкой:
    /// `Σ min(aᵢ, bᵢ) · 1000 / max(Σa, Σb)`, ‰.
    ///
    /// Почти нулевое сходство между эпохами одной личности — маркер передачи
    /// аккаунта между операторами; **слишком высокое** (replay одного шаблона) —
    /// тоже аномалия (немонотонная калибровочная кривая, FPP-SIGNALS Приложение A).
    /// `None`, если хотя бы один профиль ниже минимальной выборки.
    pub fn similarity_permille(&self, other: &HourHistogram) -> Option<u32> {
        let total_a = self.total();
        let total_b = other.total();
        if total_a < MIN_PROFILE_EVENTS as u128 || total_b < MIN_PROFILE_EVENTS as u128 {
            return None;
        }
        let overlap: u128 = self
            .counts
            .iter()
            .zip(other.counts.iter())
            .map(|(&a, &b)| a.min(b) as u128)
            .sum();
        Some((overlap * 1000 / total_a.max(total_b)) as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn burstiness_regular_stream_is_minus_1000() {
        let regular = [3600u64; 12];
        assert_eq!(burstiness_permille(&regular), Some(-1000));
        let zeros = [0u64; 8];
        assert_eq!(burstiness_permille(&zeros), Some(-1000));
    }

    #[test]
    fn burstiness_needs_min_sample() {
        assert_eq!(burstiness_permille(&[60; 7]), None);
        assert_eq!(burstiness_permille(&[]), None);
    }

    #[test]
    fn burstiness_bursty_stream_is_positive() {
        // Пачки коротких интервалов + длинные паузы — человеческий паттерн.
        let bursty = [5u64, 3, 8, 4, 90_000, 6, 2, 7, 86_000, 5, 4, 120_000];
        let b = burstiness_permille(&bursty).unwrap();
        assert!(b > 200, "b={b}");
        assert!(b <= 1000);
    }

    #[test]
    fn burstiness_alternating_is_bounded() {
        let alt = [60u64, 7200, 60, 7200, 60, 7200, 60, 7200];
        let b = burstiness_permille(&alt).unwrap();
        assert!((-1000..=1000).contains(&b));
    }

    #[test]
    fn burstiness_clamps_huge_intervals() {
        let mut xs = [60u64; 8];
        xs[0] = u64::MAX;
        let clamped = burstiness_permille(&xs).unwrap();
        let mut xs_ref = [60u64; 8];
        xs_ref[0] = MAX_INTERVAL_S;
        assert_eq!(Some(clamped), burstiness_permille(&xs_ref));
    }

    fn human_profile() -> HourHistogram {
        HourHistogram::new([
            2, 0, 0, 0, 0, 0, 1, 3, 5, 6, 5, 4, 5, 6, 5, 4, 5, 6, 7, 8, 9, 6, 4, 3,
        ])
    }

    #[test]
    fn rest_share_low_for_humans_high_for_uniform() {
        let human = human_profile().rest_share_permille().unwrap();
        assert!(human < 50, "human={human}");
        let uniform = HourHistogram::new([10; 24]).rest_share_permille().unwrap();
        assert_eq!(uniform, 250);
    }

    #[test]
    fn rest_share_is_cyclic() {
        // Окно сна, пересекающее полночь (22:00–04:00), должно находиться.
        let mut counts = [10u64; 24];
        for h in [22, 23, 0, 1, 2, 3] {
            counts[h] = 0;
        }
        let rest = HourHistogram::new(counts).rest_share_permille().unwrap();
        assert_eq!(rest, 0);
    }

    #[test]
    fn peak_share_extremes() {
        let mut spike = [0u64; 24];
        spike[3] = 240;
        assert_eq!(HourHistogram::new(spike).peak_share_permille(), Some(1000));
        assert_eq!(
            HourHistogram::new([10; 24]).peak_share_permille(),
            Some(41) // 1000/24, усечение
        );
    }

    #[test]
    fn profile_metrics_need_min_sample() {
        let sparse = HourHistogram::new([
            1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ]);
        assert_eq!(sparse.rest_share_permille(), None);
        assert_eq!(sparse.peak_share_permille(), None);
        assert_eq!(sparse.similarity_permille(&human_profile()), None);
    }

    #[test]
    fn similarity_identity_and_disjoint() {
        let human = human_profile();
        assert_eq!(human.similarity_permille(&human), Some(1000));
        let mut night = [0u64; 24];
        night[0..6].fill(10);
        let mut day = [0u64; 24];
        day[12..18].fill(10);
        assert_eq!(
            HourHistogram::new(night).similarity_permille(&HourHistogram::new(day)),
            Some(0)
        );
    }
}
