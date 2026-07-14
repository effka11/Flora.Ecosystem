//! Модуль Notifications. Перенос — Фаза 4, вместе с Messaging (next-architecture.md §6);
//! владелец — таблица §6.0. SSE-инварианты — §4.6.

/// HTTP-роутер модуля (signals/stream, уведомления, push-токены). До cutover Фазы 4 пуст —
/// запросы обслуживает C#-хост через gateway-fallback.
pub fn router() -> axum::Router {
    axum::Router::new()
}
