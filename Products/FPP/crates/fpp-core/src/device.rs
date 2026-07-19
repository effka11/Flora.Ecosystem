//! NS-D2 / NS-D3 — девайс-метрики (FPP-SIGNALS §2).
//!
//! Вход — счётчики, которые Verification наблюдает сам (класс A): сколько активных
//! civic-личностей предъявили один эпохальный тег устройства (`fpp-crypto::device_tag_epoch`)
//! и сколько разных тегов предъявила одна личность за эпоху. Классификация — сигнал
//! к следствию, не приговор: домохозяйства делят устройства легитимно.

use fpp_contracts::{DeviceChurnClass, DeviceLinkClass};

/// Порог NS-D2 по умолчанию: со скольких личностей на девайсе начинается `Shared`.
pub const DEFAULT_SHARED_MIN: u32 = 2;
/// Порог NS-D2 по умолчанию: со скольких личностей на девайсе начинается `FarmSuspect`.
pub const DEFAULT_FARM_SUSPECT_MIN: u32 = 4;

/// NS-D2: класс конкурентности устройства — сколько активных civic-личностей
/// делят один эпохальный тег. Пороги — R2-параметры; приоритет сверху вниз:
/// `n ≥ farm_suspect_min` → `FarmSuspect`, иначе `n ≥ shared_min` → `Shared`.
pub fn device_link_class(
    concurrent_civic: u32,
    shared_min: u32,
    farm_suspect_min: u32,
) -> DeviceLinkClass {
    if concurrent_civic >= farm_suspect_min {
        DeviceLinkClass::FarmSuspect
    } else if concurrent_civic >= shared_min {
        DeviceLinkClass::Shared
    } else {
        DeviceLinkClass::Exclusive
    }
}

/// Порог NS-D3 по умолчанию: со скольких разных устройств за эпоху начинается `Mobile`.
pub const DEFAULT_MOBILE_MIN: u32 = 3;
/// Порог NS-D3 по умолчанию: со скольких разных устройств за эпоху начинается `Churning`.
pub const DEFAULT_CHURNING_MIN: u32 = 5;

/// NS-D3: класс текучки устройств одной личности за эпоху. Высокая ротация вместе
/// с частыми восстановлениями (FPP §6) — маркер аренды/кражи личности.
pub fn device_churn_class(
    distinct_devices_epoch: u32,
    mobile_min: u32,
    churning_min: u32,
) -> DeviceChurnClass {
    if distinct_devices_epoch >= churning_min {
        DeviceChurnClass::Churning
    } else if distinct_devices_epoch >= mobile_min {
        DeviceChurnClass::Mobile
    } else {
        DeviceChurnClass::Stable
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_class_defaults() {
        let f = |n| device_link_class(n, DEFAULT_SHARED_MIN, DEFAULT_FARM_SUSPECT_MIN);
        assert_eq!(f(0), DeviceLinkClass::Exclusive);
        assert_eq!(f(1), DeviceLinkClass::Exclusive);
        assert_eq!(f(2), DeviceLinkClass::Shared);
        assert_eq!(f(3), DeviceLinkClass::Shared);
        assert_eq!(f(4), DeviceLinkClass::FarmSuspect);
        assert_eq!(f(40), DeviceLinkClass::FarmSuspect);
    }

    #[test]
    fn churn_class_defaults() {
        let f = |n| device_churn_class(n, DEFAULT_MOBILE_MIN, DEFAULT_CHURNING_MIN);
        assert_eq!(f(0), DeviceChurnClass::Stable);
        assert_eq!(f(2), DeviceChurnClass::Stable);
        assert_eq!(f(3), DeviceChurnClass::Mobile);
        assert_eq!(f(4), DeviceChurnClass::Mobile);
        assert_eq!(f(5), DeviceChurnClass::Churning);
    }
}
