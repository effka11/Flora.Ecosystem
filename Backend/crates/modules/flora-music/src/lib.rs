//! Модуль Music. Перенос — Фаза 1 (next-architecture.md §6); владелец — таблица §6.0.
//!
//! Внутренняя слоистость при переносе: `src/domain/`, `src/application/`,
//! `src/infrastructure/`, `src/http/` + `compose()` (§2.2).

/// HTTP-роутер модуля (`/api/music/*`). До cutover Фазы 1 пуст —
/// запросы обслуживает C#-хост через gateway-fallback.
pub fn router() -> axum::Router {
    axum::Router::new()
}
