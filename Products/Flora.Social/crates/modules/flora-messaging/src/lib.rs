//! Модуль Messaging. Перенос — Фаза 4, вместе с Notifications (next-architecture.md §6).
//! Перед правками E2E-поверхности обязателен skill `/flora-fscp-e2e`; владелец — таблица §6.0.
//!
//! FSCP wire validation — functional product `Products/FSCP` (`fscp_core`).

/// Re-export FSCP validator for callers that historically used `flora_messaging::fscp`.
pub use fscp_core as fscp;

/// HTTP-роутер модуля (FSCP-сообщения, E2E-ключи, ассеты). До cutover Фазы 4 пуст —
/// запросы обслуживает C#-хост через gateway-fallback.
pub fn router() -> axum::Router {
    axum::Router::new()
}
