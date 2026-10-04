//! NS-T3 — односторонний CUSUM по агрегатным потокам (FPP-SIGNALS §2).
//!
//! Вход — счётчики за такт (регистрации, поручительства, декларации слотов) —
//! всегда-агрегатные серверные наблюдения класса A без каких-либо личных данных.
//! Детектор ловит темпоральные всплески (закупка аккаунтов, скоординированная
//! регистрация фермы) — телеметрия V-01 (THREATS: «темпоральная кластеризация
//! регистраций/поручительств (CUSUM по потоку)»).

/// Односторонний CUSUM в милли-единицах (×1000, целые).
///
/// `s ← max(0, s + x·1000 − k)`; тревога при `s ≥ h`, после тревоги состояние
/// сбрасывается в 0 (стандартный restart). `k` (reference) — ожидаемый уровень
/// плюс допуск на такт; `h` (threshold) — накопленный сверхлимит до тревоги.
/// Оба — R2-параметры (FPP-SIGNALS Приложение A).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cusum {
    reference_milli: u64,
    threshold_milli: u64,
    state_milli: u64,
}

impl Cusum {
    pub const fn new(reference_milli: u64, threshold_milli: u64) -> Cusum {
        Cusum {
            reference_milli,
            threshold_milli,
            state_milli: 0,
        }
    }

    /// Текущее накопленное состояние (милли-единицы).
    pub const fn state_milli(&self) -> u64 {
        self.state_milli
    }

    /// Шаг детектора: подать счётчик такта, получить признак тревоги.
    pub fn step(&mut self, count: u64) -> bool {
        let inflow = (count as u128) * 1000;
        let next = (self.state_milli as u128 + inflow).saturating_sub(self.reference_milli as u128);
        let next = next.min(u64::MAX as u128) as u64;
        if next >= self.threshold_milli {
            self.state_milli = 0;
            true
        } else {
            self.state_milli = next;
            false
        }
    }
}

/// Прогон детектора по серии: индексы тактов, на которых сработала тревога.
pub fn detect_bursts(counts: &[u64], reference_milli: u64, threshold_milli: u64) -> Vec<usize> {
    let mut cusum = Cusum::new(reference_milli, threshold_milli);
    counts
        .iter()
        .enumerate()
        .filter_map(|(i, &c)| cusum.step(c).then_some(i))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steady_stream_never_alarms() {
        // Уровень 4/такт при reference 5/такт — состояние прижато к нулю.
        let counts = [4u64; 100];
        assert!(detect_bursts(&counts, 5_000, 20_000).is_empty());
    }

    #[test]
    fn burst_alarms_and_resets() {
        // Такт 5: 1000 + 30000 − 5000 = 26000 ≥ 20000 → тревога + сброс;
        // такт 6: 25000 − 5000 = 20000 → тревога; такт 9: 50000 − 5000 → тревога.
        let counts = [3u64, 4, 5, 4, 6, 30, 25, 4, 3, 50, 2];
        let alarms = detect_bursts(&counts, 5_000, 20_000);
        assert_eq!(alarms, vec![5, 6, 9]);
    }

    #[test]
    fn slow_drift_accumulates() {
        // 7/такт при reference 5/такт: +2000 милли за такт → тревога на 10-м такте.
        let counts = [7u64; 20];
        let alarms = detect_bursts(&counts, 5_000, 20_000);
        assert_eq!(alarms.first(), Some(&9));
    }

    #[test]
    fn state_is_observable_and_saturating() {
        let mut c = Cusum::new(0, u64::MAX);
        assert!(!c.step(1_000_000));
        assert_eq!(c.state_milli(), 1_000_000_000);
        // Насыщение: гигантский вход зажимается в u64::MAX, достигает порога → тревога.
        assert!(c.step(u64::MAX));
        assert_eq!(c.state_milli(), 0);
    }
}
