//! Модуль Messaging. Перенос — Фаза 4, вместе с Notifications (next-architecture.md §6).
//! Перед правками E2E-поверхности обязателен skill `/flora-fscp-e2e`; владелец — таблица §6.0.

/// HTTP-роутер модуля (FSCP-сообщения, E2E-ключи, ассеты). До cutover Фазы 4 пуст —
/// запросы обслуживает C#-хост через gateway-fallback.
pub fn router() -> axum::Router {
    axum::Router::new()
}
