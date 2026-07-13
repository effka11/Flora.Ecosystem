//! Модуль Users. Перенос — Фаза 2b, вместе с Auth (next-architecture.md §6); владелец — §6.0.

/// HTTP-роутер модуля (профили/аватары/подписки/поиск). До cutover Фазы 2b пуст —
/// запросы обслуживает C#-хост через gateway-fallback.
pub fn router() -> axum::Router {
    axum::Router::new()
}
