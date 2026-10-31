//! Фоновый бэкфилл TOTP-секретов в запечатанный формат и ротация ключей.
//!
//! SQL-миграция не подходит: ключ есть только у приложения. Поэтому воркер
//! (по образцу [`crate::application::replay_cleanup`]) идёт keyset-страницами по
//! PK и переписывает строки compare-and-swap'ом, чтобы не перетереть гонку с
//! `begin_two_factor_setup`.
//!
//! Два прохода за цикл:
//! 1. **Бэкфилл** — legacy base32 → `v1:…`.
//! 2. **Ротация** — строки под неактивным key id перепечатываются под активный,
//!    иначе старый ключ нельзя вывести из конфига никогда.
//!
//! Логи — только счётчики (`sealed`, `resealed`, `raced`, `failed`), ни секретов,
//! ни ciphertext. Первый тик — сразу после старта: бэкфилл начинается немедленно.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::infrastructure::repo::{AuthRepo, TotpSecretRow};
use crate::infrastructure::totp_at_rest::TotpAtRest;

/// Интервал между циклами. Бэкфилл одноразовый, ротация — редкая операция.
pub const TOTP_RESEAL_INTERVAL_SECS: u64 = 60;
/// Верхняя граница одной страницы (bounded batch).
pub const TOTP_RESEAL_BATCH: i64 = 200;
/// Максимум страниц за цикл: держит нагрузку ограниченной (≤4000 строк/мин).
pub const TOTP_RESEAL_MAX_BATCHES_PER_CYCLE: u32 = 20;

const LOG_TARGET: &str = "flora_auth::totp_reseal";

/// Параметры воркера.
#[derive(Debug, Clone)]
pub struct TotpResealConfig {
    pub interval: Duration,
    pub batch_limit: i64,
    pub max_batches_per_cycle: u32,
}

impl Default for TotpResealConfig {
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(TOTP_RESEAL_INTERVAL_SECS),
            batch_limit: TOTP_RESEAL_BATCH,
            max_batches_per_cycle: TOTP_RESEAL_MAX_BATCHES_PER_CYCLE,
        }
    }
}

/// Счётчики цикла. `sealed` — legacy → `v1:`, `resealed` — смена key id,
/// `raced` — CAS-miss (строку успел переписать кто-то ещё), `failed` — ошибка
/// чтения/расшифровки.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ResealStats {
    pub sealed: u64,
    pub resealed: u64,
    pub raced: u64,
    pub failed: u64,
}

impl ResealStats {
    fn merge(self, other: Self) -> Self {
        Self {
            sealed: self.sealed + other.sealed,
            resealed: self.resealed + other.resealed,
            raced: self.raced + other.raced,
            failed: self.failed + other.failed,
        }
    }

    fn touched(self) -> u64 {
        self.sealed + self.resealed + self.raced
    }
}

/// Спавнит воркер. Хэндл кладётся в фоновые задачи хоста и abort-ится при
/// shutdown. Спавнится только в sealed-режиме: в `Plain` работы нет.
pub fn spawn_totp_reseal(
    repo: Arc<AuthRepo>,
    at_rest: Arc<TotpAtRest>,
    config: TotpResealConfig,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(config.interval);
        loop {
            // Первый тик interval'а завершается сразу — бэкфилл стартует на
            // деплое, а не через interval.
            ticker.tick().await;
            let stats = run_cycle(&repo, &at_rest, &config).await;
            if stats != ResealStats::default() {
                tracing::info!(
                    target: LOG_TARGET,
                    sealed = stats.sealed,
                    resealed = stats.resealed,
                    raced = stats.raced,
                    failed = stats.failed,
                    "auth totp reseal cycle"
                );
            }
        }
    })
}

/// Один цикл: бэкфилл legacy-строк, затем (в sealed-режиме) ротация ключей.
/// Публичен, чтобы PG-тест и ручной прогон шли тем же путём, что и воркер.
pub async fn run_cycle(
    repo: &AuthRepo,
    at_rest: &TotpAtRest,
    config: &TotpResealConfig,
) -> ResealStats {
    let backfill = backfill_pass(
        at_rest,
        |after, limit| async move {
            repo.list_plaintext_totp_secrets(after, limit)
                .await
                .map_err(|e| e.to_string())
        },
        |user_uuid, expected, replacement| async move {
            repo.compare_and_swap_two_factor_secret(user_uuid, &expected, &replacement, Utc::now())
                .await
                .map_err(|e| e.to_string())
        },
        config,
    )
    .await;

    if !at_rest.is_sealed() {
        return backfill;
    }
    // В sealed-режиме кольцо есть всегда (см. конструкторы `TotpAtRest`).
    let TotpAtRest::Sealed(ring) = at_rest else {
        return backfill;
    };
    let active_key_id = ring.active_key_id().to_string();
    let rotation = rotate_pass(
        at_rest,
        |limit| {
            let active_key_id = active_key_id.clone();
            async move {
                repo.list_totp_secrets_not_under_key(&active_key_id, limit)
                    .await
                    .map_err(|e| e.to_string())
            }
        },
        |user_uuid, expected, replacement| async move {
            repo.compare_and_swap_two_factor_secret(user_uuid, &expected, &replacement, Utc::now())
                .await
                .map_err(|e| e.to_string())
        },
        config,
    )
    .await;
    backfill.merge(rotation)
}

/// Keyset-страницы legacy-строк: курсор двигается по `user_uuid`, страница
/// ограничена `batch_limit`, число страниц — `max_batches_per_cycle`.
async fn backfill_pass<F, Fut, C, CFut>(
    at_rest: &TotpAtRest,
    mut fetch_page: F,
    mut cas: C,
    config: &TotpResealConfig,
) -> ResealStats
where
    F: FnMut(Option<Uuid>, i64) -> Fut,
    Fut: Future<Output = Result<Vec<TotpSecretRow>, String>>,
    C: FnMut(Uuid, String, String) -> CFut,
    CFut: Future<Output = Result<bool, String>>,
{
    let mut stats = ResealStats::default();
    let mut cursor: Option<Uuid> = None;
    for _ in 0..config.max_batches_per_cycle {
        let page = match fetch_page(cursor, config.batch_limit).await {
            Ok(page) => page,
            Err(error) => {
                tracing::warn!(target: LOG_TARGET, %error, "auth totp reseal page failed");
                break;
            }
        };
        let full = page.len() as i64 >= config.batch_limit;
        cursor = page.last().map(|row| row.user_uuid);
        for row in page {
            let replacement = at_rest.seal(row.user_uuid, &row.two_factor_secret);
            match cas(row.user_uuid, row.two_factor_secret, replacement).await {
                Ok(true) => stats.sealed += 1,
                Ok(false) => stats.raced += 1,
                Err(error) => {
                    stats.failed += 1;
                    tracing::warn!(target: LOG_TARGET, %error, "auth totp reseal cas failed");
                }
            }
        }
        if !full {
            break;
        }
    }
    stats
}

/// Проход ротации: строки неактивного key id перепечатываются под активный.
/// Ровно как бэкфилл — батчами и CAS; страница, не давшая прогресса (все строки
/// не расшифровались), прекращает цикл, чтобы не крутить одни и те же строки.
async fn rotate_pass<F, Fut, C, CFut>(
    at_rest: &TotpAtRest,
    mut fetch_page: F,
    mut cas: C,
    config: &TotpResealConfig,
) -> ResealStats
where
    F: FnMut(i64) -> Fut,
    Fut: Future<Output = Result<Vec<TotpSecretRow>, String>>,
    C: FnMut(Uuid, String, String) -> CFut,
    CFut: Future<Output = Result<bool, String>>,
{
    let mut stats = ResealStats::default();
    for _ in 0..config.max_batches_per_cycle {
        let page = match fetch_page(config.batch_limit).await {
            Ok(page) => page,
            Err(error) => {
                tracing::warn!(target: LOG_TARGET, %error, "auth totp reseal page failed");
                break;
            }
        };
        let full = page.len() as i64 >= config.batch_limit;
        let before = stats;
        for row in page {
            let plaintext = match at_rest.open(row.user_uuid, &row.two_factor_secret) {
                Ok(plaintext) => plaintext,
                Err(error) => {
                    stats.failed += 1;
                    tracing::warn!(target: LOG_TARGET, %error, "auth totp reseal unseal failed");
                    continue;
                }
            };
            let replacement = at_rest.seal(row.user_uuid, &plaintext);
            match cas(row.user_uuid, row.two_factor_secret, replacement).await {
                Ok(true) => stats.resealed += 1,
                Ok(false) => stats.raced += 1,
                Err(error) => {
                    stats.failed += 1;
                    tracing::warn!(target: LOG_TARGET, %error, "auth totp reseal cas failed");
                }
            }
        }
        // CAS-miss тоже уводит строку из выборки; застой означает, что строки
        // не читаются (нет ключа) — повторять их в этом цикле бессмысленно.
        if !full || stats.touched() == before.touched() {
            break;
        }
    }
    stats
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    const KEY_LEN: usize = 32;

    fn at_rest() -> TotpAtRest {
        let mut keys = HashMap::new();
        keys.insert("k1".to_string(), [7_u8; KEY_LEN]);
        TotpAtRest::Sealed(
            crate::infrastructure::auth_key_ring::AuthKeyRing::new("k1", keys).unwrap(),
        )
    }

    fn row(seed: u128, secret: &str) -> TotpSecretRow {
        TotpSecretRow {
            user_uuid: Uuid::from_u128(seed),
            two_factor_secret: secret.to_string(),
        }
    }

    fn config(batch_limit: i64, max_batches: u32) -> TotpResealConfig {
        TotpResealConfig {
            interval: Duration::from_secs(1),
            batch_limit,
            max_batches_per_cycle: max_batches,
        }
    }

    #[tokio::test]
    async fn backfill_stops_at_max_batches() {
        let calls = RefCell::new(0_u32);
        let stats = backfill_pass(
            &at_rest(),
            |_after, limit| {
                let mut calls = calls.borrow_mut();
                *calls += 1;
                let start = (*calls as u128) * 10;
                async move {
                    Ok((0..limit)
                        .map(|i| row(start + u128::from(i as u64), "JBSWY3DPEHPK3PXN"))
                        .collect())
                }
            },
            |_uuid, _expected, _replacement| async { Ok(true) },
            &config(2, 3),
        )
        .await;
        assert_eq!(stats.sealed, 6, "3 батча × 2 строки");
        assert_eq!(*calls.borrow(), 3, "не превышает max_batches_per_cycle");
    }

    #[tokio::test]
    async fn backfill_stops_on_partial_page() {
        let calls = RefCell::new(0_u32);
        let stats = backfill_pass(
            &at_rest(),
            |_after, limit| {
                let mut calls = calls.borrow_mut();
                *calls += 1;
                let n = if *calls == 1 { limit as usize } else { 1 };
                async move {
                    Ok((0..n)
                        .map(|i| row(100 + i as u128, "JBSWY3DPEHPK3PXN"))
                        .collect())
                }
            },
            |_uuid, _expected, _replacement| async { Ok(true) },
            &config(3, 20),
        )
        .await;
        assert_eq!(stats.sealed, 4);
        assert_eq!(*calls.borrow(), 2, "неполная страница исчерпала бэклог");
    }

    #[tokio::test]
    async fn backfill_cursor_moves_by_user_uuid() {
        let cursors = RefCell::new(Vec::<Option<Uuid>>::new());
        let data = [
            row(1, "A"),
            row(2, "B"),
            row(3, "C"),
            row(4, "D"),
            row(5, "E"),
        ];
        let stats = backfill_pass(
            &at_rest(),
            |after, limit| {
                cursors.borrow_mut().push(after);
                let filtered: Vec<TotpSecretRow> = data
                    .iter()
                    .filter(|r| after.is_none_or(|cursor| r.user_uuid > cursor))
                    .take(limit as usize)
                    .cloned()
                    .collect();
                async move { Ok(filtered) }
            },
            |_uuid, _expected, _replacement| async { Ok(true) },
            &config(2, 20),
        )
        .await;
        assert_eq!(stats.sealed, 5);
        assert_eq!(
            *cursors.borrow(),
            vec![None, Some(Uuid::from_u128(2)), Some(Uuid::from_u128(4))]
        );
    }

    #[tokio::test]
    async fn empty_backlog_is_single_probe() {
        let calls = RefCell::new(0_u32);
        let stats = backfill_pass(
            &at_rest(),
            |_after, _limit| {
                *calls.borrow_mut() += 1;
                async { Ok(Vec::new()) }
            },
            |_uuid, _expected, _replacement| async { Ok(true) },
            &config(200, 20),
        )
        .await;
        assert_eq!(stats, ResealStats::default());
        assert_eq!(*calls.borrow(), 1);
    }

    #[tokio::test]
    async fn cas_miss_counts_as_raced_and_does_not_spin() {
        let calls = RefCell::new(0_u32);
        let stats = backfill_pass(
            &at_rest(),
            |_after, limit| {
                let mut calls = calls.borrow_mut();
                *calls += 1;
                let start = (*calls as u128) * 10;
                async move {
                    Ok((0..limit)
                        .map(|i| row(start + u128::from(i as u64), "JBSWY3DPEHPK3PXN"))
                        .collect())
                }
            },
            |_uuid, _expected, _replacement| async { Ok(false) },
            &config(2, 3),
        )
        .await;
        assert_eq!(stats.raced, 6);
        assert_eq!(stats.sealed, 0);
        assert_eq!(
            *calls.borrow(),
            3,
            "keyset-курсор двигается даже на CAS-miss"
        );
    }

    #[tokio::test]
    async fn backfill_error_stops_cycle() {
        let calls = RefCell::new(0_u32);
        let stats = backfill_pass(
            &at_rest(),
            |_after, _limit| {
                *calls.borrow_mut() += 1;
                async { Err::<Vec<TotpSecretRow>, String>("db down".into()) }
            },
            |_uuid, _expected, _replacement| async { Ok(true) },
            &config(200, 20),
        )
        .await;
        assert_eq!(stats, ResealStats::default());
        assert_eq!(
            *calls.borrow(),
            1,
            "ошибка прекращает цикл до следующего тика"
        );
    }

    #[tokio::test]
    async fn rotation_reseals_under_active_key() {
        let (at_rest, seeded) = rotated_fixture();
        let stored = RefCell::new(seeded.clone());
        let stats = rotate_pass(
            &at_rest,
            |limit| {
                let rows: Vec<TotpSecretRow> = stored
                    .borrow()
                    .iter()
                    .filter(|r| !r.two_factor_secret.starts_with("v1:k-new:"))
                    .take(limit as usize)
                    .cloned()
                    .collect();
                async move { Ok(rows) }
            },
            |uuid, expected, replacement| {
                let mut stored = stored.borrow_mut();
                let swapped = stored
                    .iter_mut()
                    .find(|r| r.user_uuid == uuid)
                    .is_some_and(|row| {
                        let matches = row.two_factor_secret == expected;
                        if matches {
                            row.two_factor_secret = replacement;
                        }
                        matches
                    });
                async move { Ok::<bool, String>(swapped) }
            },
            &config(10, 5),
        )
        .await;
        assert_eq!(stats.resealed, 2);
        assert!(
            stored
                .borrow()
                .iter()
                .all(|r| r.two_factor_secret.starts_with("v1:k-new:")),
            "все строки под активным ключом"
        );
        for row in stored.borrow().iter() {
            assert_eq!(
                at_rest.open(row.user_uuid, &row.two_factor_secret).unwrap(),
                "JBSWY3DPEHPK3PXN"
            );
        }
    }

    #[tokio::test]
    async fn rotation_without_progress_stops_after_one_page() {
        let at_rest = at_rest();
        let calls = RefCell::new(0_u32);
        let stats = rotate_pass(
            &at_rest,
            |limit| {
                *calls.borrow_mut() += 1;
                async move {
                    Ok((0..limit)
                        .map(|i| row(500 + u128::from(i as u64), "v1:k-deleted:AAAA:BBBB"))
                        .collect())
                }
            },
            |_uuid, _expected, _replacement| async { Ok(true) },
            &config(2, 10),
        )
        .await;
        assert_eq!(stats.failed, 2);
        assert_eq!(stats.resealed, 0);
        assert_eq!(*calls.borrow(), 1, "застой не крутит цикл");
    }

    fn rotated_fixture() -> (TotpAtRest, Vec<TotpSecretRow>) {
        let mut old_keys = HashMap::new();
        old_keys.insert("k-old".to_string(), [3_u8; KEY_LEN]);
        let old = TotpAtRest::Sealed(
            crate::infrastructure::auth_key_ring::AuthKeyRing::new("k-old", old_keys).unwrap(),
        );
        let seeded = vec![
            row(11, &old.seal(Uuid::from_u128(11), "JBSWY3DPEHPK3PXN")),
            row(12, &old.seal(Uuid::from_u128(12), "JBSWY3DPEHPK3PXN")),
        ];
        let mut keys = HashMap::new();
        keys.insert("k-old".to_string(), [3_u8; KEY_LEN]);
        keys.insert("k-new".to_string(), [4_u8; KEY_LEN]);
        (
            TotpAtRest::Sealed(
                crate::infrastructure::auth_key_ring::AuthKeyRing::new("k-new", keys).unwrap(),
            ),
            seeded,
        )
    }
}
