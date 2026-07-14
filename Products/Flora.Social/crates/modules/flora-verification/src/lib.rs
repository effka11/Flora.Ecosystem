//! Модуль Verification. Перенос — Фаза 2a (next-architecture.md §6); владелец — таблица §6.0.
//!
//! У модуля нет публичной HTTP-поверхности (только межмодульный порт challenge/SMTP);
//! в Фазе 2a `compose()` поднимет tonic-сервер `verification.proto` (§5.2).

/// HTTP-роутер модуля — у Verification публичных маршрутов нет, роутер остаётся пустым.
pub fn router() -> axum::Router {
    axum::Router::new()
}
