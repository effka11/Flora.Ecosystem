//! Модуль Economy — Flora Economic Protocol (FEP).
//!
//! Первый модуль, **рождающийся сразу в Rust** (C#-аналога нет, в strangler-миграции §6
//! не участвует; маршруты `/api/economy/*` не перекрываются с .NET-хостом).
//!
//! Нормативная спецификация — `Documents/fep/FEP.md`; валютный слой (LIV) — `Documents/fep/LIV.md`;
//! философия и угрозы — `FEP-GUIDE.md`, `FEP-THREATS.md`. Детерминированное ядро (арифметика,
//! журнал, инварианты) — отдельный crate [`flora_economy_crypto`]: он же собирается в wasm32
//! для клиентской верификации.
//!
//! Слои (next-architecture.md §2.2):
//! - [`domain`] — идентичность аккаунтов, часы секвенсора;
//! - [`application`] — [`application::EconomyService`]: единственный писатель журнала;
//! - [`infrastructure`] — хранилища журнала и косайнов (in-memory / JSONL append-only);
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
use std::time::Duration;

use flora_verification_contracts::PersonhoodAttestor;

use crate::application::EconomyService;
use crate::infrastructure::{CosignStore, LedgerStore};

/// Собранный модуль: роутер + порты для композиции продукта.
pub struct EconomyModule {
    pub router: axum::Router,
    /// Порт для Users/Auth (открытие аккаунта при онбординге).
    pub provisioner: Arc<dyn flora_economy_contracts::EconomyAccountProvisioner>,
    /// Порт чтения для governance-дашбордов.
    pub read_port: Arc<dyn flora_economy_contracts::EconomyReadPort>,
    /// Сервис — для фоновой задачи демерреджа ([`spawn_demurrage_worker`]).
    pub service: Arc<EconomyService>,
}

/// Композиция модуля (§2.4: без DI-контейнера, зависимости — конструкторами).
///
/// Хранилища, реестр витнессов и аттестор выбирает продукт: reference-конфигурация —
/// JSONL-журнал + JSONL-sidecar косайнов на диске, витнессы из конфига и консервативный
/// аттестор (см. [`infrastructure`]).
pub fn compose(
    store: Arc<dyn LedgerStore>,
    cosign_store: Arc<dyn CosignStore>,
    witnesses: Vec<flora_economy_crypto::sig::PublicKeyBytes>,
    attestor: Arc<dyn PersonhoodAttestor>,
) -> Result<EconomyModule, flora_economy_crypto::EconomyError> {
    let service = Arc::new(EconomyService::open(
        store,
        cosign_store,
        witnesses,
        attestor,
    )?);
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

/// Фоновый демерредж-обход: деньги «ржавеют» без участия владельца (FEP.md §3).
///
/// Обход идемпотентен (`sweep_demurrage` пишет записи только за полные истёкшие периоды),
/// поэтому период тика — вопрос оперативности, не корректности: пропущенные тики доберёт
/// следующий. Ошибки логируются и не роняют воркер: временный отказ диска не должен
/// останавливать экономику навсегда.
pub fn spawn_demurrage_worker(
    service: Arc<EconomyService>,
    every: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(every).await;
            let svc = service.clone();
            match tokio::task::spawn_blocking(move || svc.sweep_demurrage()).await {
                Ok(Ok(0)) => {}
                Ok(Ok(written)) => {
                    eprintln!("flora-economy: демерредж начислен, записей: {written}");
                }
                Ok(Err(e)) => eprintln!("flora-economy: демерредж-обход не удался: {e}"),
                Err(e) => eprintln!("flora-economy: демерредж-задача прервана: {e}"),
            }
        }
    })
}
