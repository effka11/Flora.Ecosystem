//! Модуль Content. Перенос — Фаза 3 (next-architecture.md §6); владелец — таблица §6.0.
//!
//! Уже перенесено (до cutover, паритет закреплён golden-векторами `docs/test-vectors/fira/`):
//! чистые скореры FIRA-F/FIRA-C и постобработка ленты — [`application`].

pub mod application;

/// HTTP-роутер модуля (лента/посты/сообщества). До cutover Фазы 3 пуст —
/// запросы обслуживает C#-хост через gateway-fallback.
pub fn router() -> axum::Router {
    axum::Router::new()
}
