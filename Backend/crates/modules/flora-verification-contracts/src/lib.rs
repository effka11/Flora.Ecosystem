//! Контракты модуля Verification — DTO и trait-порты без бизнес-логики (next-architecture.md §2.2).
//!
//! Наполняется в Фазе 2a: сюда переезжает порт `IVerificationChallengeService`
//! (challenge-хранилище + SMTP). Чужим модулям разрешена зависимость только от этого crate (§2.3).
//!
//! Уже объявлен personhood-порт (`FPP.md` §Architecture Position): потребители — Governance (FGP)
//! и Economy (FEP). Реализация — модуль Verification (сегодня V0 = email; уровни V1+ появятся
//! с реализацией FPP). До этого композиция может внедрять консервативную заглушку
//! «все — V0» (FEP при этом не начисляет UBI — отказобезопасное направление).

use uuid::Uuid;

/// Уровень подтверждённой человечности (FPP §2; права уровней — FGP §4.1.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PersonhoodLevel {
    /// Email-код — не personhood (`C_identity ≈ 0`).
    V0,
    /// Liveness-церемонии: гражданский базис (голос, UBI).
    V1,
    /// Web-of-trust (≥ 3 поручителя V2+): жюри и панели.
    V2,
    /// Внешний якорь: делегат, emergency circle.
    V3,
}

/// Порт «уровень человечности аккаунта» (trait `PersonhoodAttestor`, FPP).
///
/// Потребители обязаны трактовать ошибку/незнание как V0 (fail-safe: права не выдаются
/// при недоступности аттестора, а не наоборот).
pub trait PersonhoodAttestor: Send + Sync {
    /// Актуальный (не истёкший, не приостановленный) уровень аттестации аккаунта.
    fn active_level(&self, account_uuid: Uuid) -> PersonhoodLevel;
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
}
