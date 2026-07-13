//! Продукт Flora.Social — единственное место композиции модулей
//! (порт `Products/Flora.Social/FloraSocialComposition.cs`). Без бизнес-логики.
//!
//! Вместо DI-контейнера — явная композиция (next-architecture.md §2.4): продукт собирает
//! состояния модулей и внедряет реализации портов конструкторами. По мере фаз миграции
//! сюда добавляются `compose(cfg, pg_pool)` модулей, их фоновые задачи и rate-limit
//! политики (`SocialRateLimitPolicies`, §4.5).

use flora_shared::config::FloraConfig;

/// Объединённый роутер продукта. Порядок композиции повторяет C#-продукт:
/// Users → Verification → Auth → Notifications → Content → Messaging → Music,
/// затем Rust-native модули (Economy — C#-аналога нет, fallback не задействуется).
///
/// До первых cutover'ов модульные роутеры пусты: всё, что здесь не смэтчилось,
/// хост (flora-api) отправляет в .NET через gateway-fallback (§5.1).
pub fn product_router(cfg: &FloraConfig) -> axum::Router {
    axum::Router::new()
        .merge(flora_users::router())
        .merge(flora_verification::router())
        .merge(flora_auth::router())
        .merge(flora_notifications::router())
        .merge(flora_content::router())
        .merge(flora_messaging::router())
        .merge(flora_music::router())
        .merge(economy_router(cfg))
}

/// Композиция Economy (FEP): включается флагом `Economy:Enabled`.
///
/// Хранилище журнала — JSONL-файл `Economy:LedgerPath` (по умолчанию `flora-economy.ledger.jsonl`
/// в рабочем каталоге). Аттестор — консервативный (все V0, UBI не начисляется), пока модуль
/// Verification не реализует уровни FPP; экономика при этом полностью работоспособна
/// (переводы, взаимный кредит, журнал).
///
/// Ошибка композиции (повреждённый журнал, расхождение реплея) — модуль офлайн, продукт
/// продолжает работать: лестница деградации FGP §7.3, статус-кво вместо работы поверх
/// скомпрометированного состояния.
fn economy_router(cfg: &FloraConfig) -> axum::Router {
    if cfg.get_bool("Economy:Enabled") != Some(true) {
        return flora_economy::router();
    }
    let path = cfg
        .get_non_empty("Economy:LedgerPath")
        .unwrap_or("flora-economy.ledger.jsonl");
    let store = std::sync::Arc::new(flora_economy::infrastructure::JsonlLedgerStore::new(
        std::path::PathBuf::from(path),
    ));
    let attestor = std::sync::Arc::new(flora_economy::infrastructure::ConservativeAttestor);
    match flora_economy::compose(store, attestor) {
        Ok(module) => module.router,
        Err(e) => {
            eprintln!("flora-economy: композиция отклонена, модуль офлайн: {e}");
            flora_economy::router()
        }
    }
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

    #[tokio::test]
    async fn economy_disabled_by_default() {
        let router = product_router(&FloraConfig::default());
        let response = router
            .oneshot(
                http::Request::builder()
                    .uri("/api/economy/ledger/head")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn economy_enabled_serves_ledger_head() {
        let path =
            std::env::temp_dir().join(format!("flora-social-economy-{}.jsonl", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let cfg = FloraConfig::from_layers(
            "Development",
            &[serde_json::json!({
                "Economy": { "Enabled": true, "LedgerPath": path.to_string_lossy() }
            })],
            &[],
        );
        let router = product_router(&cfg);
        let response = router
            .oneshot(
                http::Request::builder()
                    .uri("/api/economy/ledger/head")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), http::StatusCode::OK);
        let _ = std::fs::remove_file(&path);
    }
}
