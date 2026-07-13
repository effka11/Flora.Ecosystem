//! Контракты модуля Verification — DTO и trait-порты без бизнес-логики (next-architecture.md §2.2).
//!
//! Наполняется в Фазе 2a: сюда переезжает порт `IVerificationChallengeService`
//! (challenge-хранилище + SMTP). Чужим модулям разрешена зависимость только от этого crate (§2.3).
