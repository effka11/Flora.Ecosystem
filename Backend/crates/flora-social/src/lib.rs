//! Продукт Flora.Social — единственное место композиции модулей
//! (порт `Products/Flora.Social/FloraSocialComposition.cs`). Без бизнес-логики.
//!
//! Вместо DI-контейнера — явная композиция (next-architecture.md §2.4): продукт собирает
//! состояния модулей и внедряет реализации портов конструкторами. По мере фаз миграции
//! сюда добавляются `compose(cfg, pg_pool)` модулей, их фоновые задачи и rate-limit
//! политики (`SocialRateLimitPolicies`, §4.5).

use flora_shared::config::FloraConfig;

/// Объединённый роутер продукта. Порядок композиции повторяет C#-продукт:
/// Users → Verification → Auth → Notifications → Content → Messaging → Music.
///
/// До первых cutover'ов модульные роутеры пусты: всё, что здесь не смэтчилось,
/// хост (flora-api) отправляет в .NET через gateway-fallback (§5.1).
pub fn product_router(_cfg: &FloraConfig) -> axum::Router {
    axum::Router::new()
        .merge(flora_users::router())
        .merge(flora_verification::router())
        .merge(flora_auth::router())
        .merge(flora_notifications::router())
        .merge(flora_content::router())
        .merge(flora_messaging::router())
        .merge(flora_music::router())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::util::ServiceExt;

    #[tokio::test]
    async fn empty_product_router_matches_nothing() {
        // Пока модули не перенесены, продукт не должен перехватывать ни один путь —
        // иначе gateway-fallback не отдаст запрос в .NET.
        let router = product_router(&FloraConfig::default());
        let response = router
            .oneshot(
                http::Request::builder()
                    .uri("/api/music/library")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), http::StatusCode::NOT_FOUND);
    }
}
