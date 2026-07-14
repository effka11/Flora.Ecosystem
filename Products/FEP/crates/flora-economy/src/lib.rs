//! Модуль Economy — Flora Economic Protocol (FEP).
//!
//! Первый модуль, **рождающийся сразу в Rust** (C#-аналога нет, в strangler-миграции §6
//! не участвует; маршруты `/api/economy/*` не перекрываются с .NET-хостом).
//!
//! Нормативная спецификация — `docs/fep/FEP.md`; философия и угрозы — `FEP-GUIDE.md`,
//! `FEP-THREATS.md`. Детерминированное ядро (арифметика, журнал, инварианты) — отдельный
//! crate [`flora_economy_crypto`]: он же собирается в wasm32 для клиентской верификации.
//!
//! Слои (next-architecture.md §2.2):
//! - [`domain`] — идентичность аккаунтов, часы секвенсора;
//! - [`application`] — [`application::EconomyService`]: единственный писатель журнала;
//! - [`infrastructure`] — хранилище журнала (in-memory / JSONL append-only);
//! - [`http`] — тонкие axum-хендлеры `/api/economy/*`.
//!
//! Межмодульные связи — только порты:
//! - потребляет `flora_verification_contracts::PersonhoodAttestor` (UBI требует V1+, FPP §2);
//! - реализует `flora_economy_contracts::{EconomyAccountProvisioner, EconomyReadPort}`.

pub mod application;
pub mod domain;
pub mod http;
pub mod infrastructure;

use std::sync::Arc;

use flora_verification_contracts::PersonhoodAttestor;

use crate::application::EconomyService;
use crate::infrastructure::LedgerStore;

/// Собранный модуль: роутер + порты для композиции продукта.
pub struct EconomyModule {
    pub router: axum::Router,
    /// Порт для Users/Auth (открытие аккаунта при онбординге).
    pub provisioner: Arc<dyn flora_economy_contracts::EconomyAccountProvisioner>,
    /// Порт чтения для governance-дашбордов.
    pub read_port: Arc<dyn flora_economy_contracts::EconomyReadPort>,
    /// Сервис — для фоновой задачи демерреджа (продукт решает, когда запускать sweep).
    pub service: Arc<EconomyService>,
}

/// Композиция модуля (§2.4: без DI-контейнера, зависимости — конструкторами).
///
/// `store` и `attestor` выбирает продукт: reference-конфигурация — JSONL-журнал на диске
/// и консервативный аттестор (см. [`infrastructure`]).
pub fn compose(
    store: Arc<dyn LedgerStore>,
    attestor: Arc<dyn PersonhoodAttestor>,
) -> Result<EconomyModule, flora_economy_crypto::EconomyError> {
    let service = Arc::new(EconomyService::open(store, attestor)?);
    Ok(EconomyModule {
        router: http::router(service.clone()),
        provisioner: service.clone(),
        read_port: service.clone(),
        service,
    })
}

/// HTTP-роутер модуля без внешних зависимостей (для продукта до включения экономики):
/// пустой, как у остальных модулей до cutover.
pub fn router() -> axum::Router {
    axum::Router::new()
}
