//! Модуль Users. Перенос — Фаза 2b, вместе с Auth (next-architecture.md §6); владелец — §6.0.
//!
//! Уже перенесено (до cutover, паритет закреплён golden-вектором `fira-p-scorer-v1.json`):
//! чистый скорер FIRA-P — [`application::people`].

pub mod application;

/// HTTP-роутер модуля (профили/аватары/подписки/поиск). До cutover Фазы 2b пуст —
/// запросы обслуживает C#-хост через gateway-fallback.
pub fn router() -> axum::Router {
    axum::Router::new()
}
