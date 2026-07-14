//! Модуль Auth. Перенос — Фаза 2b, вместе с Users (next-architecture.md §6); владелец — §6.0.
//!
//! JWT-примитивы ([`infrastructure::jwt`]) живут здесь с Фазы 0: они нужны хосту для
//! защиты нативных маршрутов и для кросс-языкового паритетного теста (§4.1).

pub mod infrastructure;

/// HTTP-роутер модуля (login/refresh/2FA/sessions). До cutover Фазы 2b пуст —
/// запросы обслуживает C#-хост через gateway-fallback.
pub fn router() -> axum::Router {
    axum::Router::new()
}
