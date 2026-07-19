//! Экономические параметры FEP.
//!
//! Значения по умолчанию — стартовые (нормативно: `Documents/fep/FEP.md`, Приложение A); их изменение —
//! решение governance класса **R2** (двухключевая модель FGP §4.0). Движок получает параметры
//! снаружи и не содержит «магических» констант в логике: экономика управляется людьми через FGP,
//! а не хардкодом.

use serde::{Deserialize, Serialize};

use crate::amount::{Grains, LIV_IN_GRAINS};
use crate::fixed::Fixed;

/// Длительность демерредж-периода по умолчанию: сутки (в миллисекундах).
pub const DEFAULT_DEMURRAGE_PERIOD_MS: i64 = 24 * 60 * 60 * 1000;

/// Длительность UBI-эпохи по умолчанию: 30 суток (в миллисекундах) — рифмуется с
/// эпохами QV-кредитов FGP, но короче: базовый доход должен приходить ощутимо регулярно.
pub const DEFAULT_UBI_EPOCH_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Параметры протокола. Все поля — «ручки» governance (R2), кроме инвариантов,
/// которые в параметры не вынесены сознательно (например, запрет отрицательных балансов).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Parameters {
    /// Ставка демерреджа за один период, ppm (частей на миллион).
    /// 191 ppm/сутки ≈ 6.7 %/год — коридор Гезелля/Вёргля (5–8 %/год).
    pub demurrage_ppm_per_period: u32,

    /// Длительность демерредж-периода, мс.
    pub demurrage_period_ms: i64,

    /// Балансы ниже этого порога демерреджем не облагаются (защита «малых кошельков»:
    /// налог на простой — для накоплений, а не для карманных денег).
    pub demurrage_exempt_threshold: Grains,

    /// Размер базового дохода на человека (V1+) за эпоху.
    pub ubi_per_epoch: Grains,

    /// Длительность UBI-эпохи, мс.
    pub ubi_epoch_ms: i64,

    /// Максимум ретроактивно начисляемых UBI-эпох (включая текущую): вернувшийся после
    /// отсутствия получает ограниченный хвост, «мёртвые души» не копят UBI годами.
    pub ubi_max_backfill_epochs: u64,

    /// Максимальный лимит одной линии доверия (анти-риск: каскад дефолтов ограничен сверху).
    pub trustline_max_limit: Grains,

    /// Максимальная длина пути взаимного кредита (глубина транзитивного доверия).
    pub credit_path_max_hops: u8,
}

impl Parameters {
    /// Стартовые значения v1 (FEP.md Приложение A).
    pub fn genesis() -> Parameters {
        Parameters {
            demurrage_ppm_per_period: 191,
            demurrage_period_ms: DEFAULT_DEMURRAGE_PERIOD_MS,
            demurrage_exempt_threshold: Grains(100 * LIV_IN_GRAINS),
            ubi_per_epoch: Grains(1000 * LIV_IN_GRAINS),
            ubi_epoch_ms: DEFAULT_UBI_EPOCH_MS,
            ubi_max_backfill_epochs: 3,
            trustline_max_limit: Grains(5000 * LIV_IN_GRAINS),
            credit_path_max_hops: 4,
        }
    }

    /// Коэффициент сохранения за один период: `1 - ppm/10^6` в Q32.32.
    pub fn retention_per_period(&self) -> Fixed {
        let ppm = self.demurrage_ppm_per_period.min(1_000_000) as i64;
        Fixed::from_ratio(1_000_000 - ppm, 1_000_000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn genesis_parameters_are_sane() {
        let p = Parameters::genesis();
        assert!(p.demurrage_ppm_per_period > 0);
        assert!(p.demurrage_period_ms > 0);
        assert!(p.ubi_per_epoch.0 > 0);
        assert!(p.ubi_epoch_ms > 0);
        assert!(p.credit_path_max_hops >= 2);
    }

    #[test]
    fn retention_is_below_one_and_positive() {
        let p = Parameters::genesis();
        let r = p.retention_per_period();
        assert!(r > Fixed::ZERO);
        assert!(r < Fixed::ONE);
    }

    #[test]
    fn yearly_decay_is_in_gesell_corridor() {
        // 191 ppm/сутки за 365 суток ≈ 6.7 % годовых — внутри коридора 5–8 %.
        let p = Parameters::genesis();
        let yearly = p.retention_per_period().pow(365).to_f64_lossy();
        assert!(
            yearly > 0.92 && yearly < 0.95,
            "yearly retention = {yearly}"
        );
    }

    #[test]
    fn ppm_above_million_saturates_to_full_decay() {
        let p = Parameters {
            demurrage_ppm_per_period: 2_000_000,
            ..Parameters::genesis()
        };
        assert_eq!(p.retention_per_period(), Fixed::ZERO);
    }
}
