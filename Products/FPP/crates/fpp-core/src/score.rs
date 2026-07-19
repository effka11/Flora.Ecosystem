//! Свод NS-сигналов в скор и класс натуральности (FPP-SIGNALS §4).
//!
//! Advisory-only: класс приоритизирует следственную очередь V-01, калибрует
//! вероятность канареечных пар и входит отдельной строкой в замер `C_hat` —
//! и никогда не деградирует уровень автоматически (FPP §8.3).

use fpp_contracts::{NaturalnessClass, SignalEvidenceClass};

use crate::piecewise;

/// Одно наблюдение: натуральность сигнала (‰, 1000 = максимально естественно)
/// и его вес. Значения выше 1000 зажимаются при своде.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignalReading {
    pub naturalness_permille: u32,
    pub weight: u32,
}

impl SignalReading {
    /// Наблюдение с весом по классу доказательности ([`evidence_weight`]).
    pub const fn with_evidence(
        naturalness_permille: u32,
        evidence: SignalEvidenceClass,
    ) -> SignalReading {
        SignalReading {
            naturalness_permille,
            weight: evidence_weight(evidence),
        }
    }
}

/// Стартовые веса по классам доказательности (FPP-SIGNALS §4, Приложение A; R2):
/// серверные наблюдения доминируют, самоотчёты никогда их не перевешивают.
pub const fn evidence_weight(evidence: SignalEvidenceClass) -> u32 {
    match evidence {
        SignalEvidenceClass::ServerObserved => 3,
        SignalEvidenceClass::DeviceAttested => 2,
        SignalEvidenceClass::SelfReported => 1,
    }
}

/// Взвешенное среднее доступных сигналов, ‰. Отсутствующий сигнал не участвует —
/// вес перенормируется по доступным (правило нейтрального отсутствия, FPP-SIGNALS §6).
/// `None` при пустом наборе или нулевом суммарном весе. Деление — усечение к нулю.
pub fn combine(readings: &[SignalReading]) -> Option<u32> {
    let mut num: u128 = 0;
    let mut den: u128 = 0;
    for r in readings {
        num += r.naturalness_permille.min(1000) as u128 * r.weight as u128;
        den += r.weight as u128;
    }
    if den == 0 {
        return None;
    }
    Some((num / den) as u32)
}

/// Пороги классификации (‰) и полоса гистерезиса. Стартовые значения —
/// FPP-SIGNALS Приложение A (класс R2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClassThresholds {
    /// Ниже — `Watch` (если не `Investigate`).
    pub watch_below: u32,
    /// Ниже — `Investigate`.
    pub investigate_below: u32,
    /// Полоса гистерезиса: смена класса требует пробить порог на `hysteresis`
    /// в сторону смены — дрожание скора вокруг порога не «мигает» классом.
    pub hysteresis: u32,
}

impl Default for ClassThresholds {
    fn default() -> ClassThresholds {
        ClassThresholds {
            watch_below: 600,
            investigate_below: 350,
            hysteresis: 50,
        }
    }
}

/// Классификация скора с гистерезисом.
///
/// Без предыдущего класса — прямое сравнение с порогами. С предыдущим:
/// ухудшение требует `score < порог − hysteresis`, улучшение — `score ≥ порог + hysteresis`.
pub fn classify(
    score_permille: u32,
    previous: Option<NaturalnessClass>,
    th: &ClassThresholds,
) -> NaturalnessClass {
    let s = score_permille.min(1000);
    let plain = |s: u32| {
        if s < th.investigate_below {
            NaturalnessClass::Investigate
        } else if s < th.watch_below {
            NaturalnessClass::Watch
        } else {
            NaturalnessClass::Natural
        }
    };
    let Some(prev) = previous else {
        return plain(s);
    };
    let watch_worse = th.watch_below.saturating_sub(th.hysteresis);
    let inv_worse = th.investigate_below.saturating_sub(th.hysteresis);
    let watch_better = th.watch_below.saturating_add(th.hysteresis);
    let inv_better = th.investigate_below.saturating_add(th.hysteresis);
    match prev {
        NaturalnessClass::Natural => {
            if s < inv_worse {
                NaturalnessClass::Investigate
            } else if s < watch_worse {
                NaturalnessClass::Watch
            } else {
                NaturalnessClass::Natural
            }
        }
        NaturalnessClass::Watch => {
            if s < inv_worse {
                NaturalnessClass::Investigate
            } else if s >= watch_better {
                NaturalnessClass::Natural
            } else {
                NaturalnessClass::Watch
            }
        }
        NaturalnessClass::Investigate => {
            if s >= watch_better {
                NaturalnessClass::Natural
            } else if s >= inv_better {
                NaturalnessClass::Watch
            } else {
                NaturalnessClass::Investigate
            }
        }
    }
}

/// Стартовая калибровка NS-T1 (burstiness ‰ → натуральность ‰): регулярность
/// машинна, bursty-паттерн человечен (FPP-SIGNALS Приложение A; R2).
pub const BURSTINESS_CURVE: &[(i64, u32)] = &[
    (-1000, 0),
    (-500, 100),
    (-200, 450),
    (0, 700),
    (250, 1000),
    (700, 1000),
    (1000, 800),
];

/// Стартовая калибровка NS-T2a (доля тихого 6-часового окна ‰ → натуральность ‰):
/// у человека есть окно сна (значение мало); 250‰ = равномерная автоматика.
pub const REST_SHARE_CURVE: &[(i64, u32)] = &[
    (0, 1000),
    (50, 950),
    (100, 750),
    (150, 450),
    (200, 200),
    (250, 80),
];

/// Стартовая калибровка NS-T2b (доля пикового часа ‰ → натуральность ‰):
/// неестественны оба хвоста — идеальная равномерность (≈ 42‰) и один час-cron (1000‰).
pub const PEAK_SHARE_CURVE: &[(i64, u32)] = &[
    (0, 150),
    (41, 250),
    (70, 700),
    (120, 1000),
    (250, 900),
    (450, 450),
    (700, 120),
    (1000, 0),
];

/// Стартовая калибровка NS-T2c (самоподобие профиля эпоха-к-эпохе ‰ → натуральность ‰):
/// около нуля — передача аккаунта между операторами, около 1000 — replay шаблона.
pub const SELF_SIMILARITY_CURVE: &[(i64, u32)] = &[
    (0, 150),
    (250, 550),
    (500, 950),
    (800, 1000),
    (930, 600),
    (1000, 250),
];

/// Удобный шорткат: прогнать сырую метрику через калибровочную кривую.
pub fn calibrate(curve: &[(i64, u32)], raw: i64) -> u32 {
    piecewise::eval(curve, raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combine_weighted_mean() {
        let readings = [
            SignalReading {
                naturalness_permille: 950,
                weight: 3,
            },
            SignalReading {
                naturalness_permille: 700,
                weight: 2,
            },
            SignalReading {
                naturalness_permille: 400,
                weight: 1,
            },
        ];
        // (950·3 + 700·2 + 400·1) / 6 = 4650 / 6 = 775.
        assert_eq!(combine(&readings), Some(775));
    }

    #[test]
    fn combine_empty_or_weightless_is_none() {
        assert_eq!(combine(&[]), None);
        assert_eq!(
            combine(&[SignalReading {
                naturalness_permille: 500,
                weight: 0
            }]),
            None
        );
    }

    #[test]
    fn combine_clamps_overrange_values() {
        let readings = [SignalReading {
            naturalness_permille: 5000,
            weight: 1,
        }];
        assert_eq!(combine(&readings), Some(1000));
    }

    #[test]
    fn evidence_weights_order() {
        assert!(
            evidence_weight(SignalEvidenceClass::ServerObserved)
                > evidence_weight(SignalEvidenceClass::DeviceAttested)
        );
        assert!(
            evidence_weight(SignalEvidenceClass::DeviceAttested)
                > evidence_weight(SignalEvidenceClass::SelfReported)
        );
    }

    #[test]
    fn classify_without_previous() {
        let th = ClassThresholds::default();
        assert_eq!(classify(1000, None, &th), NaturalnessClass::Natural);
        assert_eq!(classify(600, None, &th), NaturalnessClass::Natural);
        assert_eq!(classify(599, None, &th), NaturalnessClass::Watch);
        assert_eq!(classify(350, None, &th), NaturalnessClass::Watch);
        assert_eq!(classify(349, None, &th), NaturalnessClass::Investigate);
        assert_eq!(classify(0, None, &th), NaturalnessClass::Investigate);
    }

    #[test]
    fn classify_hysteresis_holds_class() {
        let th = ClassThresholds::default();
        // Natural держится до 550, Watch возвращается в Natural только с 650.
        assert_eq!(
            classify(560, Some(NaturalnessClass::Natural), &th),
            NaturalnessClass::Natural
        );
        assert_eq!(
            classify(549, Some(NaturalnessClass::Natural), &th),
            NaturalnessClass::Watch
        );
        assert_eq!(
            classify(640, Some(NaturalnessClass::Watch), &th),
            NaturalnessClass::Watch
        );
        assert_eq!(
            classify(650, Some(NaturalnessClass::Watch), &th),
            NaturalnessClass::Natural
        );
        // Investigate → Watch только с 400; прыжок сразу в Natural — с 650.
        assert_eq!(
            classify(399, Some(NaturalnessClass::Investigate), &th),
            NaturalnessClass::Investigate
        );
        assert_eq!(
            classify(400, Some(NaturalnessClass::Investigate), &th),
            NaturalnessClass::Watch
        );
        assert_eq!(
            classify(650, Some(NaturalnessClass::Investigate), &th),
            NaturalnessClass::Natural
        );
        // Watch → Investigate только ниже 300.
        assert_eq!(
            classify(300, Some(NaturalnessClass::Watch), &th),
            NaturalnessClass::Watch
        );
        assert_eq!(
            classify(299, Some(NaturalnessClass::Watch), &th),
            NaturalnessClass::Investigate
        );
    }

    #[test]
    fn default_curves_direction() {
        // Регулярный бот — низкая натуральность; bursty человек — высокая.
        assert!(calibrate(BURSTINESS_CURVE, -1000) < 100);
        assert!(calibrate(BURSTINESS_CURVE, 400) == 1000);
        // Уснувший человек естественнее круглосуточной равномерности.
        assert!(calibrate(REST_SHARE_CURVE, 10) > calibrate(REST_SHARE_CURVE, 250));
        // Оба хвоста пика неестественны.
        assert!(calibrate(PEAK_SHARE_CURVE, 120) > calibrate(PEAK_SHARE_CURVE, 41));
        assert!(calibrate(PEAK_SHARE_CURVE, 120) > calibrate(PEAK_SHARE_CURVE, 1000));
        // Replay-аномалия: сходство 1000 хуже сходства 700.
        assert!(calibrate(SELF_SIMILARITY_CURVE, 1000) < calibrate(SELF_SIMILARITY_CURVE, 700));
    }
}
