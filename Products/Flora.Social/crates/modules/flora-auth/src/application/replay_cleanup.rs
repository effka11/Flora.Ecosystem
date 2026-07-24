//! Auth-owned bounded cleanup job для replay-grant'ов (plan §2).
//!
//! Периодически (tokio interval) пакетно удаляет истёкшие replay-строки по
//! индексу `valid_until`. Запускается ТОЛЬКО когда retry-safe refresh включён
//! (см. [`crate::compose_with_replay`]); при выключенном протоколе не спавнится.
//! Batch ограничен, число батчей за цикл ограничено, лог — только количество
//! удалённых строк (никаких токенов/ciphertext). Graceful shutdown — abort
//! хэндла хостом (как прочие фоновые воркеры).

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use tokio::task::JoinHandle;

use crate::infrastructure::repo::AuthRepo;

/// Интервал между циклами очистки. Replay TTL — grace (60s), но строки могут
/// накапливаться, поэтому подметаем регулярно, без спешки.
pub const REPLAY_CLEANUP_INTERVAL_SECS: u64 = 300;
/// Верхняя граница одного DELETE (bounded batch).
pub const REPLAY_CLEANUP_BATCH: i64 = 500;
/// Максимум батчей за цикл — держит нагрузку ограниченной даже при большом
/// бэклоге; остаток доберётся на следующем тике.
pub const REPLAY_CLEANUP_MAX_BATCHES_PER_CYCLE: u32 = 20;

/// Параметры cleanup-джобы.
#[derive(Debug, Clone)]
pub struct ReplayCleanupConfig {
    pub interval: Duration,
    pub batch_limit: i64,
    pub max_batches_per_cycle: u32,
}

impl Default for ReplayCleanupConfig {
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(REPLAY_CLEANUP_INTERVAL_SECS),
            batch_limit: REPLAY_CLEANUP_BATCH,
            max_batches_per_cycle: REPLAY_CLEANUP_MAX_BATCHES_PER_CYCLE,
        }
    }
}

/// Спавнит периодическую очистку. Возвращает [`JoinHandle`], который хост кладёт
/// в список фоновых задач и abort-ит при shutdown.
pub fn spawn_replay_cleanup(repo: Arc<AuthRepo>, config: ReplayCleanupConfig) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(config.interval);
        // Пропускаем немедленный первый тик — не бьём по БД сразу на старте.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let removed = drain_batches(
                || async {
                    repo.cleanup_expired_replays(Utc::now(), config.batch_limit)
                        .await
                        .map_err(|e| e.to_string())
                },
                config.batch_limit,
                config.max_batches_per_cycle,
            )
            .await;
            if removed > 0 {
                tracing::info!(
                    target: "flora_auth::replay_cleanup",
                    rows = removed,
                    "auth replay cleanup removed expired grants"
                );
            }
        }
    })
}

/// Пакетно удаляет истёкшие строки, пока батч возвращает полный лимит и не
/// превышен `max_batches`. Возвращает суммарное число удалённых строк. Ошибка
/// батча логируется и прекращает цикл (следующий тик повторит). Вынесено в
/// generic-функцию для юнит-тестов без БД.
async fn drain_batches<F, Fut>(mut delete_batch: F, batch_limit: i64, max_batches: u32) -> u64
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<u64, String>>,
{
    let mut total = 0_u64;
    for _ in 0..max_batches {
        match delete_batch().await {
            Ok(0) => break,
            Ok(n) => {
                total = total.saturating_add(n);
                // Меньше полного батча — бэклог исчерпан.
                if (n as i64) < batch_limit {
                    break;
                }
            }
            Err(error) => {
                tracing::warn!(
                    target: "flora_auth::replay_cleanup",
                    %error,
                    "auth replay cleanup batch failed"
                );
                break;
            }
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[tokio::test]
    async fn drains_until_partial_batch() {
        // Батчи: 500, 500, 10 → всего 1010, останавливается на неполном.
        let responses = [500_u64, 500, 10];
        let idx = Cell::new(0);
        let total = drain_batches(
            || {
                let i = idx.get();
                idx.set(i + 1);
                async move { Ok::<u64, String>(responses[i]) }
            },
            500,
            20,
        )
        .await;
        assert_eq!(total, 1010);
        assert_eq!(idx.get(), 3, "остановился после неполного батча");
    }

    #[tokio::test]
    async fn stops_at_max_batches_when_backlog_large() {
        // Всегда полный батч → ограничено max_batches (bounded нагрузка).
        let calls = Cell::new(0_u32);
        let total = drain_batches(
            || {
                calls.set(calls.get() + 1);
                async move { Ok::<u64, String>(500) }
            },
            500,
            3,
        )
        .await;
        assert_eq!(total, 1500);
        assert_eq!(calls.get(), 3, "не превышает max_batches за цикл");
    }

    #[tokio::test]
    async fn empty_backlog_is_single_probe() {
        let calls = Cell::new(0_u32);
        let total = drain_batches(
            || {
                calls.set(calls.get() + 1);
                async move { Ok::<u64, String>(0) }
            },
            500,
            20,
        )
        .await;
        assert_eq!(total, 0);
        assert_eq!(calls.get(), 1, "пустой бэклог — один пробный DELETE");
    }

    #[tokio::test]
    async fn error_stops_cycle() {
        let calls = Cell::new(0_u32);
        let total = drain_batches(
            || {
                calls.set(calls.get() + 1);
                async move { Err::<u64, String>("db down".into()) }
            },
            500,
            20,
        )
        .await;
        assert_eq!(total, 0);
        assert_eq!(calls.get(), 1, "ошибка прекращает цикл до следующего тика");
    }
}
