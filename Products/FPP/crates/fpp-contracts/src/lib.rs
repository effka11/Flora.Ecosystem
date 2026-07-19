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

/// Итоговый класс натуральности (FPP-SIGNALS §4). **Advisory-only** (FPP §8.3):
/// приоритизирует следственную очередь V-01 и вероятность канареечных пар —
/// никогда не деградирует уровень и не блокирует права автоматически.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NaturalnessClass {
    Natural,
    Watch,
    Investigate,
}

/// Класс аттестации ключа устройства (NS-D1). Отсутствие аттестации **нейтрально**
/// (правило нейтрального отсутствия, FPP-SIGNALS §6): web-клиент не штрафуется.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DeviceAttestationClass {
    Unattested,
    SoftwareKey,
    HardwareBacked,
}

/// Конкурентность устройства: сколько активных civic-личностей делят один девайс
/// в текущей эпохе (NS-D2). `Shared` легитимен (домохозяйство) — сигнал, не приговор.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DeviceLinkClass {
    Exclusive,
    Shared,
    FarmSuspect,
}

/// Текучка устройств одной личности за эпоху (NS-D3): высокая ротация девайсов —
/// маркер аренды/кражи личности (вместе с частотой восстановлений, FPP §6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DeviceChurnClass {
    Stable,
    Mobile,
    Churning,
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
}
