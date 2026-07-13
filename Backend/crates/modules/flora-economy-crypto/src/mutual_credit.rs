//! Взаимный кредит — ликвидность из доверия (традиция WIR/LETS/Trustlines).
//!
//! Пост-дефицитный принцип №2: деньги не обязаны быть дефицитными, чтобы работать. Пара
//! участников открывает **линию доверия** с лимитом; позиция линии — это чистый долг одной
//! стороны перед другой. Платёж по цепочке линий (A→B→C) переставляет позиции попарно —
//! суммарная позиция системы всегда **ровно ноль**: взаимный кредит не эмитирует Pollen
//! и не может быть каналом скрытой эмиссии.
//!
//! Отличия от «кредита» в капиталистическом смысле:
//! - **нет процента** — время не превращает долг в больший долг (процент — двигатель
//!   концентрации капитала, он несовместим с FGP A2);
//! - лимиты капятся параметром governance (`trustline_max_limit`) — каскад дефолтов ограничен;
//! - доверие непередаваемо и непокупаемо: линия открывается взаимными подписями двух людей.
//!
//! Ядро хранит позицию канонически: для пары (a, b) с `a < b` (лексикографически по байтам id)
//! `position > 0` означает «b должен a», `position < 0` — «a должен b».

use serde::{Deserialize, Serialize};

use crate::amount::{AccountId, Grains};
use crate::error::EconomyError;
use crate::params::Parameters;

/// Каноническая пара: меньший id первым.
pub fn canonical_pair(x: AccountId, y: AccountId) -> (AccountId, AccountId) {
    if x.0 <= y.0 { (x, y) } else { (y, x) }
}

/// Состояние линии доверия между канонической парой (lo, hi).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustlineState {
    /// Сколько lo готов кредитовать hi (максимум долга hi перед lo).
    pub limit_lo_to_hi: Grains,
    /// Сколько hi готов кредитовать lo.
    pub limit_hi_to_lo: Grains,
    /// Позиция: >0 — hi должен lo; <0 — lo должен hi.
    pub position: Grains,
}

impl TrustlineState {
    pub fn new(limit_lo_to_hi: Grains, limit_hi_to_lo: Grains) -> TrustlineState {
        TrustlineState {
            limit_lo_to_hi,
            limit_hi_to_lo,
            position: Grains::ZERO,
        }
    }

    /// Свободная ёмкость платежа **от** `payer` **к** его партнёру по этой линии.
    ///
    /// Платёж от lo к hi увеличивает долг lo (позиция движется к −limit_hi_to_lo);
    /// платёж от hi к lo — наоборот.
    pub fn capacity_from(&self, payer_is_lo: bool) -> Grains {
        if payer_is_lo {
            // Позиция может опуститься до -limit_hi_to_lo.
            Grains(self.position.0.saturating_add(self.limit_hi_to_lo.0))
        } else {
            // Позиция может подняться до +limit_lo_to_hi.
            Grains(self.limit_lo_to_hi.0.saturating_sub(self.position.0))
        }
    }

    /// Сдвинуть позицию платежом `amount` от payer к партнёру. Ошибка при нехватке ёмкости.
    pub fn shift(&mut self, payer_is_lo: bool, amount: Grains) -> Result<(), EconomyError> {
        if amount.0 <= 0 {
            return Err(EconomyError::NonPositiveAmount);
        }
        let capacity = self.capacity_from(payer_is_lo);
        if amount.0 > capacity.0 {
            return Err(EconomyError::TrustlineCapacityExceeded {
                available: capacity.0,
                required: amount.0,
            });
        }
        let delta = if payer_is_lo { -amount.0 } else { amount.0 };
        self.position = Grains(
            self.position
                .0
                .checked_add(delta)
                .ok_or(EconomyError::Overflow)?,
        );
        Ok(())
    }
}

/// Проверка пути взаимного кредита: непустой, без повторов, в пределах капа длины.
pub fn validate_path(path: &[AccountId], params: &Parameters) -> Result<(), EconomyError> {
    if path.len() < 2 || path.len() > params.credit_path_max_hops as usize + 1 {
        return Err(EconomyError::InvalidCreditPath);
    }
    for (i, a) in path.iter().enumerate() {
        for b in &path[i + 1..] {
            if a == b {
                return Err(EconomyError::InvalidCreditPath);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acc(n: u8) -> AccountId {
        AccountId([n; 16])
    }

    #[test]
    fn canonical_pair_orders_by_bytes() {
        let (lo, hi) = canonical_pair(acc(9), acc(3));
        assert_eq!(lo, acc(3));
        assert_eq!(hi, acc(9));
    }

    #[test]
    fn fresh_line_capacity_equals_limits() {
        let line = TrustlineState::new(Grains(100), Grains(50));
        // lo платит hi: долг lo растёт, ограничен limit_hi_to_lo = 50.
        assert_eq!(line.capacity_from(true), Grains(50));
        // hi платит lo: долг hi растёт, ограничен limit_lo_to_hi = 100.
        assert_eq!(line.capacity_from(false), Grains(100));
    }

    #[test]
    fn payments_shift_position_and_net_to_zero() {
        let mut line = TrustlineState::new(Grains(100), Grains(100));
        line.shift(true, Grains(30)).unwrap(); // lo → hi
        assert_eq!(line.position, Grains(-30));
        line.shift(false, Grains(30)).unwrap(); // hi → lo, взаимозачёт
        assert_eq!(line.position, Grains::ZERO);
    }

    #[test]
    fn capacity_is_enforced() {
        let mut line = TrustlineState::new(Grains(10), Grains(10));
        assert!(matches!(
            line.shift(true, Grains(11)),
            Err(EconomyError::TrustlineCapacityExceeded { .. })
        ));
        // Долг занимает ёмкость: после 7 доступно 3.
        line.shift(true, Grains(7)).unwrap();
        assert_eq!(line.capacity_from(true), Grains(3));
        // Зато встречная ёмкость выросла: hi может отдать 7 + свои 10.
        assert_eq!(line.capacity_from(false), Grains(17));
    }

    #[test]
    fn non_positive_amount_rejected() {
        let mut line = TrustlineState::new(Grains(10), Grains(10));
        assert_eq!(
            line.shift(true, Grains(0)),
            Err(EconomyError::NonPositiveAmount)
        );
        assert_eq!(
            line.shift(true, Grains(-5)),
            Err(EconomyError::NonPositiveAmount)
        );
    }

    #[test]
    fn path_validation() {
        let p = Parameters::genesis();
        assert!(validate_path(&[acc(1), acc(2)], &p).is_ok());
        assert!(validate_path(&[acc(1), acc(2), acc(3), acc(4), acc(5)], &p).is_ok());
        // Слишком длинный (max_hops=4 → максимум 5 узлов).
        assert!(validate_path(&[acc(1), acc(2), acc(3), acc(4), acc(5), acc(6)], &p).is_err());
        // Повтор узла — цикл.
        assert!(validate_path(&[acc(1), acc(2), acc(1)], &p).is_err());
        // Пустой/одиночный.
        assert!(validate_path(&[acc(1)], &p).is_err());
        assert!(validate_path(&[], &p).is_err());
    }
}
