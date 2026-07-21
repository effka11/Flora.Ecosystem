//! Bucket-профиль и отчёт панели (FPP-SIGNALS §3, §4.1).
//!
//! Две половины серверной модели данных NS:
//!
//! - **квантование** — устройство (или сервер для собственных наблюдений) сводит
//!   сырую метрику к 5-уровневому bucket'у; точное значение никуда не уходит
//!   (защита от поведенческого фингерпринтинга, FPP-SIGNALS §3);
//! - **сборка отчёта** — [`assemble`] детерминированно собирает из хранимого
//!   bucket-профиля, девайс-счётчиков и серверных счётчиков церемоний полный
//!   [`NaturalnessPanelReport`] — исчерпывающий набор переменных следственной
//!   панели V-01 / панели модерации (FPP-SIGNALS §4.1).
//!
//! Правило весов девайс-наблюдений (нормативно, FPP-SIGNALS §2 NS-D1/D2/D3):
//! **инкриминирующие** наблюдения (коллизии тегов, высокая текучка) — всегда
//! класс A: сервер видел факт; **экскульпирующие** (`Exclusive`/`Stable`) стоят
//! ровно столько, сколько стоит чеканка девайс-идентичности, — по классу
//! аттестации NS-D1. Иначе ферма без аттестации «самозаверяла» бы невиновность
//! свежим software-ключом на каждый аккаунт.

use fpp_contracts::{
    DeviceAttestationClass, DeviceChurnClass, DeviceLinkClass, EvidenceShares,
    NaturalnessPanelReport, PanelCounters, PanelSignal, ReportConsistencyClass, SignalBucket,
    SignalEvidenceClass, SignalMetric,
};

use crate::score::{self, ClassThresholds, SignalReading};
use crate::{device, piecewise};

/// Темпоральные метрики bucket-профиля (порядок фиксирован для отчёта и векторов).
pub const TEMPORAL_METRICS: [SignalMetric; 4] = [
    SignalMetric::BurstinessT1,
    SignalMetric::RestShareT2a,
    SignalMetric::PeakShareT2b,
    SignalMetric::SelfSimilarityT2c,
];

/// Границы bucket'ов NS-T1 (burstiness ‰ ∈ [−1000, 1000]): верхние исключающие
/// границы bucket'ов 0..=3; всё, что ≥ последней, — bucket 4. R2-параметр.
pub const BURSTINESS_BUCKET_EDGES: [i64; 4] = [-600, -200, 200, 600];
/// Репрезентативные точки bucket'ов NS-T1 для серверной калибровки кривой.
pub const BURSTINESS_BUCKET_REPS: [i64; 5] = [-800, -400, 0, 400, 800];

/// Границы bucket'ов NS-T2a (rest-share ‰ ∈ [0, 250]). R2-параметр.
pub const REST_SHARE_BUCKET_EDGES: [i64; 4] = [25, 75, 150, 220];
/// Репрезентативные точки bucket'ов NS-T2a.
pub const REST_SHARE_BUCKET_REPS: [i64; 5] = [10, 50, 110, 185, 240];

/// Границы bucket'ов NS-T2b (peak-share ‰ ∈ [0, 1000]). R2-параметр.
pub const PEAK_SHARE_BUCKET_EDGES: [i64; 4] = [60, 90, 260, 550];
/// Репрезентативные точки bucket'ов NS-T2b.
pub const PEAK_SHARE_BUCKET_REPS: [i64; 5] = [40, 75, 170, 400, 750];

/// Границы bucket'ов NS-T2c (self-similarity ‰ ∈ [0, 1000]). R2-параметр.
pub const SELF_SIMILARITY_BUCKET_EDGES: [i64; 4] = [200, 400, 850, 950];
/// Репрезентативные точки bucket'ов NS-T2c.
pub const SELF_SIMILARITY_BUCKET_REPS: [i64; 5] = [100, 300, 600, 900, 980];

/// Границы bucket'ов темпоральной метрики; `None` для девайс-метрик
/// (NS-D2/NS-D3 — enum-классы, не bucket'ы).
pub const fn bucket_edges(metric: SignalMetric) -> Option<&'static [i64; 4]> {
    match metric {
        SignalMetric::BurstinessT1 => Some(&BURSTINESS_BUCKET_EDGES),
        SignalMetric::RestShareT2a => Some(&REST_SHARE_BUCKET_EDGES),
        SignalMetric::PeakShareT2b => Some(&PEAK_SHARE_BUCKET_EDGES),
        SignalMetric::SelfSimilarityT2c => Some(&SELF_SIMILARITY_BUCKET_EDGES),
        SignalMetric::DeviceLinkD2 | SignalMetric::DeviceChurnD3 => None,
    }
}

/// Репрезентативные точки bucket'ов темпоральной метрики; `None` для девайс-метрик.
pub const fn bucket_representatives(metric: SignalMetric) -> Option<&'static [i64; 5]> {
    match metric {
        SignalMetric::BurstinessT1 => Some(&BURSTINESS_BUCKET_REPS),
        SignalMetric::RestShareT2a => Some(&REST_SHARE_BUCKET_REPS),
        SignalMetric::PeakShareT2b => Some(&PEAK_SHARE_BUCKET_REPS),
        SignalMetric::SelfSimilarityT2c => Some(&SELF_SIMILARITY_BUCKET_REPS),
        SignalMetric::DeviceLinkD2 | SignalMetric::DeviceChurnD3 => None,
    }
}

/// Калибровочная кривая темпоральной метрики; `None` для девайс-метрик.
pub const fn curve_for(metric: SignalMetric) -> Option<&'static [(i64, u32)]> {
    match metric {
        SignalMetric::BurstinessT1 => Some(score::BURSTINESS_CURVE),
        SignalMetric::RestShareT2a => Some(score::REST_SHARE_CURVE),
        SignalMetric::PeakShareT2b => Some(score::PEAK_SHARE_CURVE),
        SignalMetric::SelfSimilarityT2c => Some(score::SELF_SIMILARITY_CURVE),
        SignalMetric::DeviceLinkD2 | SignalMetric::DeviceChurnD3 => None,
    }
}

/// Квантовать сырую метрику в bucket: первый `i` с `raw < edges[i]`, иначе 4.
/// `None` для девайс-метрик.
pub fn quantize(metric: SignalMetric, raw: i64) -> Option<SignalBucket> {
    let edges = bucket_edges(metric)?;
    let idx = edges.iter().position(|&e| raw < e).unwrap_or(4);
    Some(SignalBucket::from_code(idx as u8).expect("индекс 0..=4"))
}

/// Репрезентативная точка bucket'а; `None` для девайс-метрик.
pub fn representative(metric: SignalMetric, bucket: SignalBucket) -> Option<i64> {
    Some(bucket_representatives(metric)?[bucket.code() as usize])
}

/// Натуральность bucket'а, ‰: калибровочная кривая метрики в репрезентативной
/// точке. Так кривые остаются серверными R2-параметрами (пере-калибровка применима
/// к уже хранимым bucket'ам), а точные значения не покидают устройство.
pub fn naturalness_for_bucket(metric: SignalMetric, bucket: SignalBucket) -> Option<u32> {
    let curve = curve_for(metric)?;
    let rep = representative(metric, bucket)?;
    Some(piecewise::eval(curve, rep))
}

/// Стартовая натуральность классов NS-D2, ‰ (R2): `Shared` легитимен
/// (домохозяйство) — мягкая просадка; `FarmSuspect` — резкая.
pub const fn device_link_naturalness(class: DeviceLinkClass) -> u32 {
    match class {
        DeviceLinkClass::Exclusive => 1000,
        DeviceLinkClass::Shared => 800,
        DeviceLinkClass::FarmSuspect => 100,
    }
}

/// Стартовая натуральность классов NS-D3, ‰ (R2): высокая текучка девайсов —
/// маркер аренды/кражи (FPP §8.2), но `Mobile` — обычная жизнь с 3–4 устройствами.
pub const fn device_churn_naturalness(class: DeviceChurnClass) -> u32 {
    match class {
        DeviceChurnClass::Stable => 1000,
        DeviceChurnClass::Mobile => 650,
        DeviceChurnClass::Churning => 150,
    }
}

/// Класс доказательности **самоотчёта** (темпоральные bucket'ы с устройства)
/// по NS-D1 (FPP-SIGNALS §1): с hardware-backed аттестацией — B, иначе — C.
/// Самоотчёт никогда не достигает класса A.
pub const fn self_report_evidence(attestation: DeviceAttestationClass) -> SignalEvidenceClass {
    match attestation {
        DeviceAttestationClass::HardwareBacked => SignalEvidenceClass::DeviceAttested,
        DeviceAttestationClass::SoftwareKey | DeviceAttestationClass::Unattested => {
            SignalEvidenceClass::SelfReported
        }
    }
}

/// Класс доказательности **девайс-наблюдения** (NS-D2/NS-D3) — асимметричное
/// правило весов:
///
/// - инкриминирующее наблюдение (`exculpatory = false`: коллизия тегов, высокая
///   текучка) — всегда A: сервер видел факт, аттестация не нужна;
/// - экскульпирующее (`Exclusive`/`Stable`) стоит столько, сколько стоит чеканка
///   девайс-идентичности: hardware-backed → A, software key → B, без аттестации → C.
///   Ферма, штампующая свежие software-ключи на аккаунт, получает за «эксклюзивность»
///   вес самоотчёта, а не серверного факта.
pub const fn device_observation_evidence(
    attestation: DeviceAttestationClass,
    exculpatory: bool,
) -> SignalEvidenceClass {
    if !exculpatory {
        return SignalEvidenceClass::ServerObserved;
    }
    match attestation {
        DeviceAttestationClass::HardwareBacked => SignalEvidenceClass::ServerObserved,
        DeviceAttestationClass::SoftwareKey => SignalEvidenceClass::DeviceAttested,
        DeviceAttestationClass::Unattested => SignalEvidenceClass::SelfReported,
    }
}

/// Порог дистанции bucket'ов, с которого согласованность — `Drifting`. R2-параметр.
pub const CONSISTENCY_DRIFTING_MIN: u8 = 2;
/// Порог дистанции bucket'ов, с которого согласованность — `Contradictory`. R2-параметр.
pub const CONSISTENCY_CONTRADICTORY_MIN: u8 = 3;

/// Bucket-профиль темпоральных метрик одного наблюдателя (устройства или сервера).
/// Отсутствующая метрика нейтральна (FPP-SIGNALS §6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TemporalBuckets {
    pub burstiness: Option<SignalBucket>,
    pub rest_share: Option<SignalBucket>,
    pub peak_share: Option<SignalBucket>,
    pub self_similarity: Option<SignalBucket>,
}

impl TemporalBuckets {
    /// Bucket метрики из профиля; `None` и для девайс-метрик.
    pub const fn get(&self, metric: SignalMetric) -> Option<SignalBucket> {
        match metric {
            SignalMetric::BurstinessT1 => self.burstiness,
            SignalMetric::RestShareT2a => self.rest_share,
            SignalMetric::PeakShareT2b => self.peak_share,
            SignalMetric::SelfSimilarityT2c => self.self_similarity,
            SignalMetric::DeviceLinkD2 | SignalMetric::DeviceChurnD3 => None,
        }
    }

    /// Квантовать сырые значения метрик (выходы [`crate::temporal`]) в профиль —
    /// клиентский путь «метрика → bucket» перед отчётом эпохи.
    pub fn quantize_raw(
        burstiness_permille: Option<i32>,
        rest_share_permille: Option<u32>,
        peak_share_permille: Option<u32>,
        self_similarity_permille: Option<u32>,
    ) -> TemporalBuckets {
        let q = |metric: SignalMetric, raw: Option<i64>| raw.and_then(|r| quantize(metric, r));
        TemporalBuckets {
            burstiness: q(
                SignalMetric::BurstinessT1,
                burstiness_permille.map(i64::from),
            ),
            rest_share: q(
                SignalMetric::RestShareT2a,
                rest_share_permille.map(i64::from),
            ),
            peak_share: q(
                SignalMetric::PeakShareT2b,
                peak_share_permille.map(i64::from),
            ),
            self_similarity: q(
                SignalMetric::SelfSimilarityT2c,
                self_similarity_permille.map(i64::from),
            ),
        }
    }
}

/// Согласованность самоотчёта с серверными наблюдениями: максимальная дистанция
/// bucket'ов по метрикам, наблюдаемым **обеими** сторонами. `None` — пересечения нет.
pub fn report_consistency(
    server: &TemporalBuckets,
    self_reported: &TemporalBuckets,
) -> Option<ReportConsistencyClass> {
    let max_distance = TEMPORAL_METRICS
        .iter()
        .filter_map(|&m| Some(server.get(m)?.distance(self_reported.get(m)?)))
        .max()?;
    Some(if max_distance >= CONSISTENCY_CONTRADICTORY_MIN {
        ReportConsistencyClass::Contradictory
    } else if max_distance >= CONSISTENCY_DRIFTING_MIN {
        ReportConsistencyClass::Drifting
    } else {
        ReportConsistencyClass::Consistent
    })
}

/// Входы сборки отчёта панели: хранимый bucket-профиль + девайс-счётчики +
/// серверные счётчики. Всё — то, что Verification уже хранит по FPP-SIGNALS §3;
/// сырые события для сборки не нужны.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportInputs {
    /// Bucket'ы, посчитанные сервером по его собственным наблюдениям (класс A).
    pub server_temporal: TemporalBuckets,
    /// Bucket'ы из отчёта устройства (класс B/C по NS-D1).
    pub self_temporal: TemporalBuckets,
    /// NS-D1: класс аттестации устройства.
    pub device_attestation: DeviceAttestationClass,
    /// NS-D2: активных civic-личностей на девайс-теге эпохи.
    pub concurrent_civic_on_device: Option<u32>,
    /// NS-D3: различных девайс-тегов личности за эпоху.
    pub distinct_devices_epoch: Option<u32>,
    /// Класс прошлой эпохи — вход гистерезиса (FPP-SIGNALS §4).
    pub previous_class: Option<fpp_contracts::NaturalnessClass>,
    /// Серверные счётчики церемоний/вердиктов/восстановлений (пасс-тру в отчёт).
    pub counters: PanelCounters,
}

impl Default for ReportInputs {
    fn default() -> ReportInputs {
        ReportInputs {
            server_temporal: TemporalBuckets::default(),
            self_temporal: TemporalBuckets::default(),
            device_attestation: DeviceAttestationClass::Unattested,
            concurrent_civic_on_device: None,
            distinct_devices_epoch: None,
            previous_class: None,
            counters: PanelCounters::default(),
        }
    }
}

/// Собрать отчёт панели (FPP-SIGNALS §4.1) из хранимых данных.
///
/// Детерминированный порядок строк `signals`: серверные темпоральные (T1, T2a,
/// T2b, T2c), самоотчётные темпоральные (тот же порядок), NS-D2, NS-D3.
/// Пороги девайс-классов — стартовые R2 ([`device`]); пороги классификации —
/// параметр `thresholds`.
pub fn assemble(inputs: &ReportInputs, thresholds: &ClassThresholds) -> NaturalnessPanelReport {
    let mut signals: Vec<PanelSignal> = Vec::new();

    for &metric in &TEMPORAL_METRICS {
        if let Some(bucket) = inputs.server_temporal.get(metric) {
            signals.push(PanelSignal {
                metric,
                evidence: SignalEvidenceClass::ServerObserved,
                bucket: Some(bucket),
                naturalness_permille: naturalness_for_bucket(metric, bucket)
                    .expect("темпоральная метрика"),
            });
        }
    }
    let self_evidence = self_report_evidence(inputs.device_attestation);
    for &metric in &TEMPORAL_METRICS {
        if let Some(bucket) = inputs.self_temporal.get(metric) {
            signals.push(PanelSignal {
                metric,
                evidence: self_evidence,
                bucket: Some(bucket),
                naturalness_permille: naturalness_for_bucket(metric, bucket)
                    .expect("темпоральная метрика"),
            });
        }
    }

    let device_link = inputs.concurrent_civic_on_device.map(|n| {
        device::device_link_class(
            n,
            device::DEFAULT_SHARED_MIN,
            device::DEFAULT_FARM_SUSPECT_MIN,
        )
    });
    if let Some(class) = device_link {
        signals.push(PanelSignal {
            metric: SignalMetric::DeviceLinkD2,
            evidence: device_observation_evidence(
                inputs.device_attestation,
                class == DeviceLinkClass::Exclusive,
            ),
            bucket: None,
            naturalness_permille: device_link_naturalness(class),
        });
    }
    let device_churn = inputs.distinct_devices_epoch.map(|n| {
        device::device_churn_class(n, device::DEFAULT_MOBILE_MIN, device::DEFAULT_CHURNING_MIN)
    });
    if let Some(class) = device_churn {
        signals.push(PanelSignal {
            metric: SignalMetric::DeviceChurnD3,
            evidence: device_observation_evidence(
                inputs.device_attestation,
                class == DeviceChurnClass::Stable,
            ),
            bucket: None,
            naturalness_permille: device_churn_naturalness(class),
        });
    }

    let readings: Vec<SignalReading> = signals
        .iter()
        .map(|s| SignalReading::with_evidence(s.naturalness_permille, s.evidence))
        .collect();
    let score_permille = score::combine(&readings);
    let class = score_permille.map(|s| score::classify(s, inputs.previous_class, thresholds));
    let evidence_shares = score_permille.map(|_| evidence_shares(&signals));

    NaturalnessPanelReport {
        score_permille,
        class,
        evidence_shares,
        report_consistency: report_consistency(&inputs.server_temporal, &inputs.self_temporal),
        signals,
        device_attestation: inputs.device_attestation,
        concurrent_civic_on_device: inputs.concurrent_civic_on_device,
        device_link,
        distinct_devices_epoch: inputs.distinct_devices_epoch,
        device_churn,
        counters: inputs.counters.clone(),
    }
}

/// Доли веса классов доказательности среди строк отчёта, ‰ (усечение к нулю).
fn evidence_shares(signals: &[PanelSignal]) -> EvidenceShares {
    let weight_of = |class: SignalEvidenceClass| -> u128 {
        signals
            .iter()
            .filter(|s| s.evidence == class)
            .map(|s| score::evidence_weight(s.evidence) as u128)
            .sum()
    };
    let a = weight_of(SignalEvidenceClass::ServerObserved);
    let b = weight_of(SignalEvidenceClass::DeviceAttested);
    let c = weight_of(SignalEvidenceClass::SelfReported);
    let total = a + b + c;
    let share = |w: u128| (w * 1000).checked_div(total).unwrap_or(0) as u32;
    EvidenceShares {
        server_observed_permille: share(a),
        device_attested_permille: share(b),
        self_reported_permille: share(c),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fpp_contracts::NaturalnessClass;

    #[test]
    fn quantize_boundaries_per_metric() {
        let q = |m, x| quantize(m, x).unwrap().code();
        // NS-T1: границы [-600, -200, 200, 600].
        assert_eq!(q(SignalMetric::BurstinessT1, -1000), 0);
        assert_eq!(q(SignalMetric::BurstinessT1, -601), 0);
        assert_eq!(q(SignalMetric::BurstinessT1, -600), 1);
        assert_eq!(q(SignalMetric::BurstinessT1, -200), 2);
        assert_eq!(q(SignalMetric::BurstinessT1, 199), 2);
        assert_eq!(q(SignalMetric::BurstinessT1, 200), 3);
        assert_eq!(q(SignalMetric::BurstinessT1, 600), 4);
        assert_eq!(q(SignalMetric::BurstinessT1, 1000), 4);
        // NS-T2a: [25, 75, 150, 220].
        assert_eq!(q(SignalMetric::RestShareT2a, 0), 0);
        assert_eq!(q(SignalMetric::RestShareT2a, 25), 1);
        assert_eq!(q(SignalMetric::RestShareT2a, 149), 2);
        assert_eq!(q(SignalMetric::RestShareT2a, 250), 4);
        // NS-T2b: [60, 90, 260, 550].
        assert_eq!(q(SignalMetric::PeakShareT2b, 41), 0);
        assert_eq!(q(SignalMetric::PeakShareT2b, 120), 2);
        assert_eq!(q(SignalMetric::PeakShareT2b, 1000), 4);
        // NS-T2c: [200, 400, 850, 950].
        assert_eq!(q(SignalMetric::SelfSimilarityT2c, 0), 0);
        assert_eq!(q(SignalMetric::SelfSimilarityT2c, 500), 2);
        assert_eq!(q(SignalMetric::SelfSimilarityT2c, 900), 3);
        assert_eq!(q(SignalMetric::SelfSimilarityT2c, 1000), 4);
        // Девайс-метрики не квантуются.
        assert_eq!(quantize(SignalMetric::DeviceLinkD2, 1), None);
        assert_eq!(quantize(SignalMetric::DeviceChurnD3, 1), None);
    }

    #[test]
    fn representatives_fall_into_their_buckets() {
        for &metric in &TEMPORAL_METRICS {
            let reps = bucket_representatives(metric).unwrap();
            for (i, &rep) in reps.iter().enumerate() {
                assert_eq!(
                    quantize(metric, rep).unwrap().code() as usize,
                    i,
                    "{} rep {rep}",
                    metric.name()
                );
            }
        }
    }

    #[test]
    fn bucket_naturalness_direction() {
        let nat = |m, b| naturalness_for_bucket(m, SignalBucket::from_code(b).unwrap()).unwrap();
        // Регулярный бот (b0) заметно ниже человеческого bursty (b3).
        assert!(nat(SignalMetric::BurstinessT1, 0) < 100);
        assert_eq!(nat(SignalMetric::BurstinessT1, 3), 1000);
        // Окно сна (b0) естественнее равномерности (b4).
        assert!(nat(SignalMetric::RestShareT2a, 0) > nat(SignalMetric::RestShareT2a, 4));
        // Оба хвоста пика неестественны относительно середины.
        assert!(nat(SignalMetric::PeakShareT2b, 2) > nat(SignalMetric::PeakShareT2b, 0));
        assert!(nat(SignalMetric::PeakShareT2b, 2) > nat(SignalMetric::PeakShareT2b, 4));
        // Немонотонность NS-T2c: и передача аккаунта (b0), и replay (b4) — аномалии.
        assert!(nat(SignalMetric::SelfSimilarityT2c, 2) > nat(SignalMetric::SelfSimilarityT2c, 0));
        assert!(nat(SignalMetric::SelfSimilarityT2c, 2) > nat(SignalMetric::SelfSimilarityT2c, 4));
    }

    #[test]
    fn evidence_rules() {
        use DeviceAttestationClass::*;
        use SignalEvidenceClass::*;
        assert_eq!(self_report_evidence(HardwareBacked), DeviceAttested);
        assert_eq!(self_report_evidence(SoftwareKey), SelfReported);
        assert_eq!(self_report_evidence(Unattested), SelfReported);
        // Инкриминирующее — всегда A.
        for att in [Unattested, SoftwareKey, HardwareBacked] {
            assert_eq!(device_observation_evidence(att, false), ServerObserved);
        }
        // Экскульпирующее — по цене чеканки девайс-идентичности.
        assert_eq!(
            device_observation_evidence(HardwareBacked, true),
            ServerObserved
        );
        assert_eq!(
            device_observation_evidence(SoftwareKey, true),
            DeviceAttested
        );
        assert_eq!(device_observation_evidence(Unattested, true), SelfReported);
    }

    #[test]
    fn consistency_distances() {
        let mk = |b: Option<u8>| TemporalBuckets {
            burstiness: b.map(|c| SignalBucket::from_code(c).unwrap()),
            ..TemporalBuckets::default()
        };
        assert_eq!(report_consistency(&mk(None), &mk(Some(3))), None);
        assert_eq!(
            report_consistency(&mk(Some(2)), &mk(Some(3))),
            Some(ReportConsistencyClass::Consistent)
        );
        assert_eq!(
            report_consistency(&mk(Some(1)), &mk(Some(3))),
            Some(ReportConsistencyClass::Drifting)
        );
        assert_eq!(
            report_consistency(&mk(Some(0)), &mk(Some(3))),
            Some(ReportConsistencyClass::Contradictory)
        );
        // Худшая метрика определяет класс.
        let server = TemporalBuckets {
            burstiness: Some(SignalBucket::Medium),
            peak_share: Some(SignalBucket::VeryLow),
            ..TemporalBuckets::default()
        };
        let self_reported = TemporalBuckets {
            burstiness: Some(SignalBucket::Medium),
            peak_share: Some(SignalBucket::VeryHigh),
            ..TemporalBuckets::default()
        };
        assert_eq!(
            report_consistency(&server, &self_reported),
            Some(ReportConsistencyClass::Contradictory)
        );
    }

    #[test]
    fn quantize_raw_maps_temporal_outputs() {
        let buckets = TemporalBuckets::quantize_raw(Some(-1000), Some(10), Some(120), None);
        assert_eq!(buckets.burstiness, Some(SignalBucket::VeryLow));
        assert_eq!(buckets.rest_share, Some(SignalBucket::VeryLow));
        assert_eq!(buckets.peak_share, Some(SignalBucket::Medium));
        assert_eq!(buckets.self_similarity, None);
    }

    #[test]
    fn assemble_empty_inputs_is_neutral() {
        let report = assemble(&ReportInputs::default(), &ClassThresholds::default());
        assert_eq!(report.score_permille, None);
        assert_eq!(report.class, None);
        assert_eq!(report.evidence_shares, None);
        assert_eq!(report.report_consistency, None);
        assert!(report.signals.is_empty());
        assert_eq!(report.device_link, None);
        assert_eq!(report.device_churn, None);
    }

    #[test]
    fn assemble_farm_scenario_investigates() {
        // Сервер видит машинную регулярность, самоотчёт рапортует «человека»,
        // на девайсе 6 личностей, 7 девайсов за эпоху.
        let inputs = ReportInputs {
            server_temporal: TemporalBuckets {
                burstiness: Some(SignalBucket::VeryLow),
                ..TemporalBuckets::default()
            },
            self_temporal: TemporalBuckets {
                burstiness: Some(SignalBucket::High),
                self_similarity: Some(SignalBucket::VeryHigh),
                ..TemporalBuckets::default()
            },
            device_attestation: DeviceAttestationClass::Unattested,
            concurrent_civic_on_device: Some(6),
            distinct_devices_epoch: Some(7),
            previous_class: Some(NaturalnessClass::Watch),
            counters: PanelCounters::default(),
        };
        let report = assemble(&inputs, &ClassThresholds::default());
        // (40·3 + 1000·1 + 350·1 + 100·3 + 150·3) / 11 = 2220 / 11 = 201.
        assert_eq!(report.score_permille, Some(201));
        assert_eq!(report.class, Some(NaturalnessClass::Investigate));
        assert_eq!(
            report.report_consistency,
            Some(ReportConsistencyClass::Contradictory)
        );
        assert_eq!(report.device_link, Some(DeviceLinkClass::FarmSuspect));
        assert_eq!(report.device_churn, Some(DeviceChurnClass::Churning));
        let shares = report.evidence_shares.unwrap();
        // Вес A: 3 (сервер) + 3 (D2) + 3 (D3) = 9 из 11.
        assert_eq!(shares.server_observed_permille, 818);
        assert_eq!(shares.device_attested_permille, 0);
        assert_eq!(shares.self_reported_permille, 181);
        assert_eq!(report.signals.len(), 5);
    }

    #[test]
    fn assemble_unattested_exclusive_gets_self_reported_weight() {
        // Ферма без аттестации не самозаверяет «эксклюзивность» весом A.
        let inputs = ReportInputs {
            concurrent_civic_on_device: Some(1),
            distinct_devices_epoch: Some(1),
            ..ReportInputs::default()
        };
        let report = assemble(&inputs, &ClassThresholds::default());
        for signal in &report.signals {
            assert_eq!(signal.evidence, SignalEvidenceClass::SelfReported);
        }
        let hw = ReportInputs {
            device_attestation: DeviceAttestationClass::HardwareBacked,
            ..inputs
        };
        let report_hw = assemble(&hw, &ClassThresholds::default());
        for signal in &report_hw.signals {
            assert_eq!(signal.evidence, SignalEvidenceClass::ServerObserved);
        }
    }

    #[test]
    fn assemble_signal_order_is_deterministic() {
        let all = TemporalBuckets {
            burstiness: Some(SignalBucket::High),
            rest_share: Some(SignalBucket::VeryLow),
            peak_share: Some(SignalBucket::Medium),
            self_similarity: Some(SignalBucket::Medium),
        };
        let inputs = ReportInputs {
            server_temporal: all,
            self_temporal: all,
            device_attestation: DeviceAttestationClass::HardwareBacked,
            concurrent_civic_on_device: Some(1),
            distinct_devices_epoch: Some(2),
            ..ReportInputs::default()
        };
        let report = assemble(&inputs, &ClassThresholds::default());
        let metrics: Vec<u8> = report.signals.iter().map(|s| s.metric.code()).collect();
        assert_eq!(metrics, vec![1, 2, 3, 4, 1, 2, 3, 4, 5, 6]);
        // Первая четвёрка — A, вторая — B (hardware-backed самоотчёт).
        assert!(
            report.signals[..4]
                .iter()
                .all(|s| s.evidence == SignalEvidenceClass::ServerObserved)
        );
        assert!(
            report.signals[4..8]
                .iter()
                .all(|s| s.evidence == SignalEvidenceClass::DeviceAttested)
        );
    }
}
