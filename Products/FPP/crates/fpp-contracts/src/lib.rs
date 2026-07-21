//! FPP contracts — personhood ports for Governance/Economy consumers.
//! Spec: `Documents/fpp/FPP.md`; naturalness layer (NS) — `Documents/fpp/FPP-SIGNALS.md`.
//! Persistence (`personhood_*`) is owned by Social Verification.

/// Personhood attestation level V0–V3 (normative names; full API lands with Verification cutover).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PersonhoodLevel {
    V0 = 0,
    V1 = 1,
    V2 = 2,
    V3 = 3,
}

/// Класс доказательности NS-сигнала (FPP-SIGNALS §1): вес сигнала определяется тем,
/// **кто его наблюдал**, а не тем, что он утверждает. Клиент подконтролен атакующему,
/// поэтому самоотчёты никогда не перевешивают серверные наблюдения.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SignalEvidenceClass {
    /// A — наблюдаемо сервером: конкурентность девайсов, потоки событий,
    /// исходы церемоний, частота восстановлений.
    ServerObserved,
    /// B — аттестовано устройством (hardware-backed ключ / платформенная аттестация).
    DeviceAttested,
    /// C — самоотчёт клиента (bucket-профили с устройства). Advisory:
    /// расхождение класса C с классом A — самостоятельный сигнал.
    SelfReported,
}

impl SignalEvidenceClass {
    /// Полный реестр классов доказательности.
    pub const ALL: &[SignalEvidenceClass] = &[
        SignalEvidenceClass::ServerObserved,
        SignalEvidenceClass::DeviceAttested,
        SignalEvidenceClass::SelfReported,
    ];

    /// Стабильное имя для векторов, журналов и панелей.
    pub const fn name(self) -> &'static str {
        match self {
            SignalEvidenceClass::ServerObserved => "server_observed",
            SignalEvidenceClass::DeviceAttested => "device_attested",
            SignalEvidenceClass::SelfReported => "self_reported",
        }
    }
}

/// Итоговый класс натуральности (FPP-SIGNALS §4). **Advisory-only** (FPP §8.3):
/// приоритизирует следственную очередь V-01 и вероятность канареечных пар —
/// никогда не деградирует уровень и не блокирует права автоматически.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NaturalnessClass {
    Natural,
    Watch,
    Investigate,
}

impl NaturalnessClass {
    /// Полный реестр классов.
    pub const ALL: &[NaturalnessClass] = &[
        NaturalnessClass::Natural,
        NaturalnessClass::Watch,
        NaturalnessClass::Investigate,
    ];

    /// Стабильное имя для векторов, журналов и панелей.
    pub const fn name(self) -> &'static str {
        match self {
            NaturalnessClass::Natural => "natural",
            NaturalnessClass::Watch => "watch",
            NaturalnessClass::Investigate => "investigate",
        }
    }
}

/// Класс аттестации ключа устройства (NS-D1). Отсутствие аттестации **нейтрально**
/// (правило нейтрального отсутствия, FPP-SIGNALS §6): web-клиент не штрафуется.
/// Класс определяет вес девайс-сигналов платформы — нормативные правила
/// `fpp-core::profile::{self_report_evidence, device_observation_evidence}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DeviceAttestationClass {
    Unattested,
    SoftwareKey,
    HardwareBacked,
}

impl DeviceAttestationClass {
    /// Полный реестр классов.
    pub const ALL: &[DeviceAttestationClass] = &[
        DeviceAttestationClass::Unattested,
        DeviceAttestationClass::SoftwareKey,
        DeviceAttestationClass::HardwareBacked,
    ];

    /// Стабильное имя для векторов, журналов и панелей.
    pub const fn name(self) -> &'static str {
        match self {
            DeviceAttestationClass::Unattested => "unattested",
            DeviceAttestationClass::SoftwareKey => "software_key",
            DeviceAttestationClass::HardwareBacked => "hardware_backed",
        }
    }
}

/// Конкурентность устройства: сколько активных civic-личностей делят один девайс
/// в текущей эпохе (NS-D2). `Shared` легитимен (домохозяйство) — сигнал, не приговор.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DeviceLinkClass {
    Exclusive,
    Shared,
    FarmSuspect,
}

impl DeviceLinkClass {
    /// Полный реестр классов.
    pub const ALL: &[DeviceLinkClass] = &[
        DeviceLinkClass::Exclusive,
        DeviceLinkClass::Shared,
        DeviceLinkClass::FarmSuspect,
    ];

    /// Стабильное имя для векторов, журналов и панелей.
    pub const fn name(self) -> &'static str {
        match self {
            DeviceLinkClass::Exclusive => "exclusive",
            DeviceLinkClass::Shared => "shared",
            DeviceLinkClass::FarmSuspect => "farm_suspect",
        }
    }
}

/// Текучка устройств одной личности за эпоху (NS-D3): высокая ротация девайсов —
/// маркер аренды/кражи личности (вместе с частотой восстановлений, FPP §6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DeviceChurnClass {
    Stable,
    Mobile,
    Churning,
}

impl DeviceChurnClass {
    /// Полный реестр классов.
    pub const ALL: &[DeviceChurnClass] = &[
        DeviceChurnClass::Stable,
        DeviceChurnClass::Mobile,
        DeviceChurnClass::Churning,
    ];

    /// Стабильное имя для векторов, журналов и панелей.
    pub const fn name(self) -> &'static str {
        match self {
            DeviceChurnClass::Stable => "stable",
            DeviceChurnClass::Mobile => "mobile",
            DeviceChurnClass::Churning => "churning",
        }
    }
}

/// Идентификатор NS-метрики в отчётах, журналах и векторах (wire-stable;
/// реестр FPP-SIGNALS §2). Код `0` зарезервирован и не сериализуется.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum SignalMetric {
    /// NS-T1 — burstiness межсобытийных интервалов.
    BurstinessT1 = 1,
    /// NS-T2a — доля активности в самом тихом циклическом 6-часовом окне.
    RestShareT2a = 2,
    /// NS-T2b — доля пикового часа суточного профиля.
    PeakShareT2b = 3,
    /// NS-T2c — самоподобие суточного профиля эпоха-к-эпохе.
    SelfSimilarityT2c = 4,
    /// NS-D2 — конкурентность эпохального девайс-тега.
    DeviceLinkD2 = 5,
    /// NS-D3 — текучка девайс-тегов личности за эпоху.
    DeviceChurnD3 = 6,
}

impl SignalMetric {
    /// Полный реестр метрик — источник для test vectors и проверок уникальности кодов.
    pub const ALL: &[SignalMetric] = &[
        SignalMetric::BurstinessT1,
        SignalMetric::RestShareT2a,
        SignalMetric::PeakShareT2b,
        SignalMetric::SelfSimilarityT2c,
        SignalMetric::DeviceLinkD2,
        SignalMetric::DeviceChurnD3,
    ];

    /// Wire-код метрики.
    pub const fn code(self) -> u8 {
        self as u8
    }

    /// Обратная конверсия из wire-кода; `None` для неизвестных кодов и нуля.
    pub const fn from_code(code: u8) -> Option<SignalMetric> {
        match code {
            1 => Some(SignalMetric::BurstinessT1),
            2 => Some(SignalMetric::RestShareT2a),
            3 => Some(SignalMetric::PeakShareT2b),
            4 => Some(SignalMetric::SelfSimilarityT2c),
            5 => Some(SignalMetric::DeviceLinkD2),
            6 => Some(SignalMetric::DeviceChurnD3),
            _ => None,
        }
    }

    /// Стабильное имя для векторов, журналов и панелей.
    pub const fn name(self) -> &'static str {
        match self {
            SignalMetric::BurstinessT1 => "ns_t1_burstiness",
            SignalMetric::RestShareT2a => "ns_t2a_rest_share",
            SignalMetric::PeakShareT2b => "ns_t2b_peak_share",
            SignalMetric::SelfSimilarityT2c => "ns_t2c_self_similarity",
            SignalMetric::DeviceLinkD2 => "ns_d2_device_link",
            SignalMetric::DeviceChurnD3 => "ns_d3_device_churn",
        }
    }
}

/// Квантованный 5-уровневый bucket сырой метрики (FPP-SIGNALS §3): на сервер уходит
/// **только bucket**, не точное значение, — хранимый профиль слишком груб для
/// поведенческого фингерпринтинга, но достаточен для приоритизации следствия.
/// Границы bucket'ов и репрезентативные точки — `fpp-core::profile` (R2-параметры).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u8)]
pub enum SignalBucket {
    VeryLow = 0,
    Low = 1,
    Medium = 2,
    High = 3,
    VeryHigh = 4,
}

impl SignalBucket {
    /// Полный реестр bucket'ов (по возрастанию).
    pub const ALL: &[SignalBucket] = &[
        SignalBucket::VeryLow,
        SignalBucket::Low,
        SignalBucket::Medium,
        SignalBucket::High,
        SignalBucket::VeryHigh,
    ];

    /// Wire-код bucket'а (0..=4).
    pub const fn code(self) -> u8 {
        self as u8
    }

    /// Обратная конверсия из wire-кода; `None` для кодов вне 0..=4.
    pub const fn from_code(code: u8) -> Option<SignalBucket> {
        match code {
            0 => Some(SignalBucket::VeryLow),
            1 => Some(SignalBucket::Low),
            2 => Some(SignalBucket::Medium),
            3 => Some(SignalBucket::High),
            4 => Some(SignalBucket::VeryHigh),
            _ => None,
        }
    }

    /// Стабильное имя для векторов, журналов и панелей.
    pub const fn name(self) -> &'static str {
        match self {
            SignalBucket::VeryLow => "very_low",
            SignalBucket::Low => "low",
            SignalBucket::Medium => "medium",
            SignalBucket::High => "high",
            SignalBucket::VeryHigh => "very_high",
        }
    }

    /// Дистанция между bucket'ами (|a − b|, 0..=4) — вход классификации
    /// согласованности самоотчёта с серверными наблюдениями.
    pub const fn distance(self, other: SignalBucket) -> u8 {
        self.code().abs_diff(other.code())
    }
}

/// Согласованность самоотчёта (класс C/B) с серверными наблюдениями (класс A)
/// по одним и тем же метрикам (FPP-SIGNALS §1): ферма, рапортующая «идеальную
/// естественность» при машинных серверных наблюдениях, выдаёт себя самим отчётом.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum ReportConsistencyClass {
    /// Расхождения в пределах шума квантования.
    Consistent = 0,
    /// Заметное расхождение — вход выборки ретестов.
    Drifting = 1,
    /// Самоотчёт противоречит наблюдениям — самостоятельный сигнал следствию.
    Contradictory = 2,
}

impl ReportConsistencyClass {
    /// Полный реестр классов (по возрастанию расхождения).
    pub const ALL: &[ReportConsistencyClass] = &[
        ReportConsistencyClass::Consistent,
        ReportConsistencyClass::Drifting,
        ReportConsistencyClass::Contradictory,
    ];

    /// Стабильное имя для векторов, журналов и панелей.
    pub const fn name(self) -> &'static str {
        match self {
            ReportConsistencyClass::Consistent => "consistent",
            ReportConsistencyClass::Drifting => "drifting",
            ReportConsistencyClass::Contradictory => "contradictory",
        }
    }
}

/// Доли веса классов доказательности в сводном скоре, ‰ (FPP-SIGNALS §4.1):
/// «на чём стоит скор». Скор 900 из одних самоотчётов и скор 900, подтверждённый
/// серверными наблюдениями, — разные уровни доверия; сумма ≤ 1000 (усечение).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EvidenceShares {
    pub server_observed_permille: u32,
    pub device_attested_permille: u32,
    pub self_reported_permille: u32,
}

/// Одна строка bucket-профиля в отчёте панели: метрика + кто её наблюдал +
/// квантованное значение + натуральность после калибровочной кривой.
/// Список таких строк исчерпывающе объясняет сводный скор.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PanelSignal {
    pub metric: SignalMetric,
    /// Класс доказательности этой строки (определяет вес в своде).
    pub evidence: SignalEvidenceClass,
    /// Квантованный bucket сырой метрики; `None` для девайс-классов
    /// (NS-D2/NS-D3 — enum-классы, не 5-уровневые bucket'ы).
    pub bucket: Option<SignalBucket>,
    /// Натуральность строки после калибровки, ‰ (1000 = максимально естественно).
    pub naturalness_permille: u32,
}

/// Счётчик enum-флага аномалий церемоний (NS-C1) за TTL-окно.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AnomalyFlagCount {
    pub flag: CeremonyAnomalyFlag,
    pub count: u32,
}

/// Счётчики, которые Verification наблюдает сам (класс A) и отдаёт в отчёт панели
/// как есть (FPP §9.1: слоты, вердикты, агрегат надёжности; FPP §6: восстановления).
/// Окна счётчиков = TTL хранения (24 мес для церемоний, 12 мес для восстановлений).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PanelCounters {
    /// Завершённые церемонии liveness за 24 мес (FPP §3.1).
    pub ceremonies_completed_24m: u32,
    /// Собственные fail'ы церемоний за 24 мес — уровень падает от **паттерна**
    /// собственных фейлов, не от единичного случая (FPP §2, §8.1).
    pub own_fails_24m: u32,
    /// Собственные неявки за 24 мес (неявки партнёра жертве не засчитываются, FPP §3.1).
    pub own_no_shows_24m: u32,
    /// Надёжность выдающего вердикты, ‰ (FPP §3.1): систематическое расхождение
    /// с исходами повторных проверок обесценивает вердикты аккаунта. `None` — нет
    /// достаточной истории вердиктов.
    pub verdict_reliability_permille: Option<u32>,
    /// Восстановления доступа за 12 мес (FPP §6: приватный флаг панелей; частые
    /// восстановления — маркер аренды/кражи личности, FPP §8.2).
    pub recoveries_12m: u32,
    /// Счётчики enum-флагов аномалий церемоний за 24 мес (NS-C1): паттерн флагов —
    /// вход детекции V-01 (deepfake-конвейер даёт систематическую латентность).
    pub anomaly_flags_24m: Vec<AnomalyFlagCount>,
}

/// Отчёт натуральности по одной civic-личности для следственной панели V-01 /
/// панели модерации (FPP-SIGNALS §4.1) — исчерпывающий набор переменных,
/// по которым панель оценивает доверие алгоритма к пользователю.
///
/// Инварианты:
/// - **Advisory-only** (FPP §8.3): отчёт приоритизирует следствие и ретесты —
///   не деградирует уровень, не блокирует права, не заменяет вердикт FGP §4.1.4.
/// - **Идентификатора субъекта в отчёте нет намеренно**: подшивку «отчёт ↔ civic_id»
///   держит вызывающая сторона (Verification), доступ журналируется (FPP-SIGNALS §3).
/// - Отчёт собирается из хранимого bucket-профиля и серверных счётчиков —
///   сырые события для него не нужны и не существуют (FPP-SIGNALS §3).
///
/// Сборка — `fpp-core::profile::assemble`; personhood-уровень V0–V3 и состояние
/// аттестации в отчёт не входят (домен Verification) — панель показывает их рядом.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NaturalnessPanelReport {
    /// Сводный скор натуральности, ‰ (1000 = максимально естественно);
    /// `None` — сигналов нет (нейтральное отсутствие, FPP-SIGNALS §6).
    pub score_permille: Option<u32>,
    /// Класс `Natural`/`Watch`/`Investigate` с гистерезисом (FPP-SIGNALS §4);
    /// `None` — скора нет.
    pub class: Option<NaturalnessClass>,
    /// Доли веса классов доказательности A/B/C в скоре; `None` — скора нет.
    pub evidence_shares: Option<EvidenceShares>,
    /// Все строки, вошедшие в свод (bucket-профиль + девайс-классы) —
    /// прозрачность скора для панели.
    pub signals: Vec<PanelSignal>,
    /// Согласованность самоотчёта с серверными наблюдениями тех же метрик;
    /// `None` — нет ни одной метрики, наблюдаемой обеими сторонами.
    pub report_consistency: Option<ReportConsistencyClass>,
    /// NS-D1: класс аттестации устройства (нейтрален сам по себе — определяет
    /// вес девайс-сигналов).
    pub device_attestation: DeviceAttestationClass,
    /// NS-D2: активных civic-личностей на девайс-теге эпохи; `None` — тег не предъявлялся.
    pub concurrent_civic_on_device: Option<u32>,
    /// NS-D2: класс конкурентности (`Shared` легитимен — домохозяйство).
    pub device_link: Option<DeviceLinkClass>,
    /// NS-D3: различных девайс-тегов личности за эпоху; `None` — наблюдений нет.
    pub distinct_devices_epoch: Option<u32>,
    /// NS-D3: класс текучки устройств.
    pub device_churn: Option<DeviceChurnClass>,
    /// Серверные счётчики церемоний/вердиктов/восстановлений (класс A).
    pub counters: PanelCounters,
}

/// Нормативные enum-коды аномалий liveness-церемоний (FPP §3.1, §9.1: на сервер уходят
/// «только подписанные вердикты и enum-флаги аномалий»; свободный текст запрещён —
/// канал утечки PII). Коды wire-stable, зафиксированы вектором
/// `personhood-naturalness-v1.json`; код `0` зарезервирован за «нет аномалии»
/// и не сериализуется.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum CeremonyAnomalyFlag {
    /// Латентность реакций на челленджи вне человеческого диапазона (deepfake-конвейер, FPP §3.2).
    LatencySuspect = 1,
    /// Артефакты синтеза видео/аудио.
    SyntheticMediaSuspect = 2,
    /// Рассинхронизация аудио и видео.
    AudioVideoDesync = 3,
    /// Действия не соответствуют общему скрипту челленджей сессии.
    ChallengeMismatch = 4,
    /// Машинная динамика ввода (NS-C1, класс доказательности B).
    InputCadenceAnomaly = 5,
    /// Сессия прервана участником («прервать и сообщить», FPP §3.1.1).
    ParticipantAborted = 6,
    /// Жалоба на абьюз (FPP §3.1.1; ≥ 2 подтверждённых → L4-трек).
    AbuseReported = 7,
    /// Неявка партнёра (жертве — make-up слот без штрафа, FPP §3.1).
    PartnerNoShow = 8,
}

impl CeremonyAnomalyFlag {
    /// Полный реестр флагов — источник для test vectors и проверок уникальности кодов.
    pub const ALL: &[CeremonyAnomalyFlag] = &[
        CeremonyAnomalyFlag::LatencySuspect,
        CeremonyAnomalyFlag::SyntheticMediaSuspect,
        CeremonyAnomalyFlag::AudioVideoDesync,
        CeremonyAnomalyFlag::ChallengeMismatch,
        CeremonyAnomalyFlag::InputCadenceAnomaly,
        CeremonyAnomalyFlag::ParticipantAborted,
        CeremonyAnomalyFlag::AbuseReported,
        CeremonyAnomalyFlag::PartnerNoShow,
    ];

    /// Wire-код флага.
    pub const fn code(self) -> u8 {
        self as u8
    }

    /// Обратная конверсия из wire-кода; `None` для неизвестных кодов и нуля.
    pub const fn from_code(code: u8) -> Option<CeremonyAnomalyFlag> {
        match code {
            1 => Some(CeremonyAnomalyFlag::LatencySuspect),
            2 => Some(CeremonyAnomalyFlag::SyntheticMediaSuspect),
            3 => Some(CeremonyAnomalyFlag::AudioVideoDesync),
            4 => Some(CeremonyAnomalyFlag::ChallengeMismatch),
            5 => Some(CeremonyAnomalyFlag::InputCadenceAnomaly),
            6 => Some(CeremonyAnomalyFlag::ParticipantAborted),
            7 => Some(CeremonyAnomalyFlag::AbuseReported),
            8 => Some(CeremonyAnomalyFlag::PartnerNoShow),
            _ => None,
        }
    }

    /// Стабильное имя для векторов и журналов (enum-код, не свободный текст).
    pub const fn name(self) -> &'static str {
        match self {
            CeremonyAnomalyFlag::LatencySuspect => "latency_suspect",
            CeremonyAnomalyFlag::SyntheticMediaSuspect => "synthetic_media_suspect",
            CeremonyAnomalyFlag::AudioVideoDesync => "audio_video_desync",
            CeremonyAnomalyFlag::ChallengeMismatch => "challenge_mismatch",
            CeremonyAnomalyFlag::InputCadenceAnomaly => "input_cadence_anomaly",
            CeremonyAnomalyFlag::ParticipantAborted => "participant_aborted",
            CeremonyAnomalyFlag::AbuseReported => "abuse_reported",
            CeremonyAnomalyFlag::PartnerNoShow => "partner_no_show",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_are_ordered() {
        assert!(PersonhoodLevel::V0 < PersonhoodLevel::V1);
        assert!(PersonhoodLevel::V1 < PersonhoodLevel::V2);
        assert!(PersonhoodLevel::V2 < PersonhoodLevel::V3);
    }

    #[test]
    fn anomaly_codes_roundtrip_and_unique() {
        for (i, flag) in CeremonyAnomalyFlag::ALL.iter().enumerate() {
            assert_eq!(CeremonyAnomalyFlag::from_code(flag.code()), Some(*flag));
            for other in &CeremonyAnomalyFlag::ALL[i + 1..] {
                assert_ne!(flag.code(), other.code());
                assert_ne!(flag.name(), other.name());
            }
        }
        assert_eq!(CeremonyAnomalyFlag::from_code(0), None);
        assert_eq!(CeremonyAnomalyFlag::from_code(255), None);
    }

    #[test]
    fn signal_metric_codes_roundtrip_and_unique() {
        for (i, metric) in SignalMetric::ALL.iter().enumerate() {
            assert_eq!(SignalMetric::from_code(metric.code()), Some(*metric));
            for other in &SignalMetric::ALL[i + 1..] {
                assert_ne!(metric.code(), other.code());
                assert_ne!(metric.name(), other.name());
            }
        }
        assert_eq!(SignalMetric::from_code(0), None);
        assert_eq!(SignalMetric::from_code(255), None);
    }

    #[test]
    fn signal_bucket_codes_ordered_and_roundtrip() {
        for (i, bucket) in SignalBucket::ALL.iter().enumerate() {
            assert_eq!(bucket.code() as usize, i);
            assert_eq!(SignalBucket::from_code(bucket.code()), Some(*bucket));
        }
        assert_eq!(SignalBucket::from_code(5), None);
        assert_eq!(SignalBucket::VeryLow.distance(SignalBucket::VeryHigh), 4);
        assert_eq!(SignalBucket::High.distance(SignalBucket::Medium), 1);
        assert_eq!(SignalBucket::Low.distance(SignalBucket::Low), 0);
    }

    #[test]
    fn stable_names_are_unique_per_registry() {
        fn assert_unique(names: &[&str]) {
            for (i, a) in names.iter().enumerate() {
                for b in &names[i + 1..] {
                    assert_ne!(a, b);
                }
            }
        }
        assert_unique(
            &NaturalnessClass::ALL
                .iter()
                .map(|c| c.name())
                .collect::<Vec<_>>(),
        );
        assert_unique(
            &SignalEvidenceClass::ALL
                .iter()
                .map(|c| c.name())
                .collect::<Vec<_>>(),
        );
        assert_unique(
            &DeviceAttestationClass::ALL
                .iter()
                .map(|c| c.name())
                .collect::<Vec<_>>(),
        );
        assert_unique(
            &DeviceLinkClass::ALL
                .iter()
                .map(|c| c.name())
                .collect::<Vec<_>>(),
        );
        assert_unique(
            &DeviceChurnClass::ALL
                .iter()
                .map(|c| c.name())
                .collect::<Vec<_>>(),
        );
        assert_unique(
            &ReportConsistencyClass::ALL
                .iter()
                .map(|c| c.name())
                .collect::<Vec<_>>(),
        );
        assert_unique(
            &SignalBucket::ALL
                .iter()
                .map(|b| b.name())
                .collect::<Vec<_>>(),
        );
    }
}
