//! Инфраструктура Economy: хранилища журнала/косайнов и заглушка аттестора.
//!
//! Журнал — главная персистентная сущность FEP (состояние — производное, реплеем).
//! Порты [`LedgerStore`] и [`CosignStore`] намеренно минимальны: `load_all` + `append` —
//! append-only по построению, никакого UPDATE/DELETE в контракте нет вовсе.
//!
//! Реализации:
//! - [`InMemoryLedgerStore`] / [`InMemoryCosignStore`] — тесты и dev;
//! - [`JsonlLedgerStore`] / [`JsonlCosignStore`] — reference-персистентность: одна
//!   JSON-запись на строку, `fsync` после каждого append. Postgres-store (таблица
//!   `flora_core.economy_ledger`) добавится вместе с регистрацией в `flora-migrate`
//!   (см. FEP.md §12).

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use flora_economy_crypto::ledger::LedgerEntry;
use flora_economy_crypto::witness::HeadCosign;
use serde::Serialize;
use serde::de::DeserializeOwned;

/// Ошибка хранилища (транспортная, не экономическая).
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("ошибка ввода-вывода журнала: {0}")]
    Io(#[from] std::io::Error),
    #[error("повреждённая запись журнала (строка {line}): {reason}")]
    Corrupt { line: usize, reason: String },
}

/// Порт хранилища журнала. Append-only: других операций записи не существует.
pub trait LedgerStore: Send + Sync {
    fn load_all(&self) -> Result<Vec<LedgerEntry>, StoreError>;
    fn append(&self, entry: &LedgerEntry) -> Result<(), StoreError>;
}

/// Порт хранилища витнесс-косайнов. Тоже append-only: косайн — исторический факт
/// («витнесс X подписал head Y»), его нельзя ни изменить, ни удалить.
pub trait CosignStore: Send + Sync {
    fn load_all(&self) -> Result<Vec<HeadCosign>, StoreError>;
    fn append(&self, cosign: &HeadCosign) -> Result<(), StoreError>;
}

/// In-memory журнал (тесты, dev-режим без диска).
#[derive(Default)]
pub struct InMemoryLedgerStore {
    entries: Mutex<Vec<LedgerEntry>>,
}

impl InMemoryLedgerStore {
    pub fn new() -> InMemoryLedgerStore {
        InMemoryLedgerStore::default()
    }
}

impl LedgerStore for InMemoryLedgerStore {
    fn load_all(&self) -> Result<Vec<LedgerEntry>, StoreError> {
        Ok(self.entries.lock().expect("mutex не отравлен").clone())
    }

    fn append(&self, entry: &LedgerEntry) -> Result<(), StoreError> {
        self.entries
            .lock()
            .expect("mutex не отравлен")
            .push(entry.clone());
        Ok(())
    }
}

/// In-memory хранилище косайнов (тесты, dev).
#[derive(Default)]
pub struct InMemoryCosignStore {
    cosigns: Mutex<Vec<HeadCosign>>,
}

impl InMemoryCosignStore {
    pub fn new() -> InMemoryCosignStore {
        InMemoryCosignStore::default()
    }
}

impl CosignStore for InMemoryCosignStore {
    fn load_all(&self) -> Result<Vec<HeadCosign>, StoreError> {
        Ok(self.cosigns.lock().expect("mutex не отравлен").clone())
    }

    fn append(&self, cosign: &HeadCosign) -> Result<(), StoreError> {
        self.cosigns
            .lock()
            .expect("mutex не отравлен")
            .push(cosign.clone());
        Ok(())
    }
}

// ---------- общий JSONL-механизм ----------

/// Прочитать все записи JSONL-файла; отсутствие файла — пустой список.
fn load_jsonl<T: DeserializeOwned>(path: &PathBuf) -> Result<Vec<T>, StoreError> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut items = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let item: T = serde_json::from_str(line).map_err(|e| StoreError::Corrupt {
            line: i + 1,
            reason: e.to_string(),
        })?;
        items.push(item);
    }
    Ok(items)
}

/// Дописать запись строкой JSON с `fsync` (журнал — источник истины, хвост терять нельзя).
fn append_jsonl<T: Serialize>(path: &PathBuf, item: &T) -> Result<(), StoreError> {
    let json = serde_json::to_string(item).map_err(|e| StoreError::Corrupt {
        line: 0,
        reason: e.to_string(),
    })?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "{json}")?;
    file.sync_data()?;
    Ok(())
}

/// JSONL-журнал на диске: одна запись — одна строка канонического JSON.
///
/// Формат сознательно человекочитаем: журнал FEP — публичный документ (FGP §6.4),
/// его можно скачать, продиффать и реплеить без спецсофта.
pub struct JsonlLedgerStore {
    path: PathBuf,
    /// Сериализация append'ов (журнал — строго последовательный).
    write_lock: Mutex<()>,
}

impl JsonlLedgerStore {
    pub fn new(path: PathBuf) -> JsonlLedgerStore {
        JsonlLedgerStore {
            path,
            write_lock: Mutex::new(()),
        }
    }
}

impl LedgerStore for JsonlLedgerStore {
    fn load_all(&self) -> Result<Vec<LedgerEntry>, StoreError> {
        load_jsonl(&self.path)
    }

    fn append(&self, entry: &LedgerEntry) -> Result<(), StoreError> {
        let _guard = self.write_lock.lock().expect("mutex не отравлен");
        append_jsonl(&self.path, entry)
    }
}

/// JSONL-sidecar косайнов витнессов (рядом с журналом: `<ledger>.cosigns.jsonl`).
///
/// Отдельный файл, а не записи журнала: косайны — **метаданные о** журнале, они не
/// участвуют в хеш-цепочке (иначе подпись head меняла бы head — циклическая зависимость).
pub struct JsonlCosignStore {
    path: PathBuf,
    write_lock: Mutex<()>,
}

impl JsonlCosignStore {
    pub fn new(path: PathBuf) -> JsonlCosignStore {
        JsonlCosignStore {
            path,
            write_lock: Mutex::new(()),
        }
    }
}

impl CosignStore for JsonlCosignStore {
    fn load_all(&self) -> Result<Vec<HeadCosign>, StoreError> {
        load_jsonl(&self.path)
    }

    fn append(&self, cosign: &HeadCosign) -> Result<(), StoreError> {
        let _guard = self.write_lock.lock().expect("mutex не отравлен");
        append_jsonl(&self.path, cosign)
    }
}

/// Консервативный аттестор: **никому** не подтверждает V1+ (все — V0).
///
/// Отказобезопасное направление FPP: пока модуль Verification не реализует liveness-церемонии,
/// UBI не начисляется никому — экономика работает (переводы, взаимный кредит), но эмиссии нет.
/// Это строже, чем «раздать всем», и не создаёт долга доверия, который потом пришлось бы
/// отзывать.
pub struct ConservativeAttestor;

impl flora_verification_contracts::PersonhoodAttestor for ConservativeAttestor {
    fn active_level(
        &self,
        _account_uuid: uuid::Uuid,
    ) -> flora_verification_contracts::PersonhoodLevel {
        flora_verification_contracts::PersonhoodLevel::V0
    }
}

/// Аттестор с фиксированным уровнем — для тестов и dev-стендов.
pub struct FixedLevelAttestor(pub flora_verification_contracts::PersonhoodLevel);

impl flora_verification_contracts::PersonhoodAttestor for FixedLevelAttestor {
    fn active_level(
        &self,
        _account_uuid: uuid::Uuid,
    ) -> flora_verification_contracts::PersonhoodLevel {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flora_economy_crypto::amount::Timestamp;
    use flora_economy_crypto::hash::ZERO_HASH;
    use flora_economy_crypto::ledger::EntryBody;
    use flora_economy_crypto::params::Parameters;

    fn genesis_entry() -> LedgerEntry {
        LedgerEntry {
            seq: 0,
            at: Timestamp(1_000),
            prev_hash: ZERO_HASH,
            body: EntryBody::Genesis {
                protocol_version: 1,
                params: Parameters::genesis(),
            },
        }
    }

    #[test]
    fn in_memory_roundtrip() {
        let store = InMemoryLedgerStore::new();
        assert!(store.load_all().unwrap().is_empty());
        store.append(&genesis_entry()).unwrap();
        assert_eq!(store.load_all().unwrap(), vec![genesis_entry()]);
    }

    #[test]
    fn jsonl_roundtrip_and_missing_file() {
        let dir = std::env::temp_dir().join(format!("fep-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ledger.jsonl");
        let _ = std::fs::remove_file(&path);

        let store = JsonlLedgerStore::new(path.clone());
        assert!(
            store.load_all().unwrap().is_empty(),
            "нет файла — пустой журнал"
        );
        store.append(&genesis_entry()).unwrap();
        assert_eq!(store.load_all().unwrap(), vec![genesis_entry()]);

        // Повторное открытие видит те же данные.
        let reopened = JsonlLedgerStore::new(path.clone());
        assert_eq!(reopened.load_all().unwrap(), vec![genesis_entry()]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn jsonl_corrupt_line_is_reported() {
        let dir = std::env::temp_dir().join(format!("fep-test-corrupt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ledger.jsonl");
        std::fs::write(&path, "{not json}\n").unwrap();
        let store = JsonlLedgerStore::new(path.clone());
        assert!(matches!(
            store.load_all(),
            Err(StoreError::Corrupt { line: 1, .. })
        ));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn jsonl_cosign_store_roundtrip() {
        use flora_economy_crypto::ledger::LedgerHead;
        use flora_economy_crypto::witness::cosign_head;

        let dir = std::env::temp_dir().join(format!("fep-test-cosigns-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cosigns.jsonl");
        let _ = std::fs::remove_file(&path);

        let store = JsonlCosignStore::new(path.clone());
        assert!(store.load_all().unwrap().is_empty(), "нет файла — пусто");

        let head = LedgerHead {
            size: 3,
            last_entry_hash: [4u8; 32],
            merkle_root: [5u8; 32],
            at: Timestamp(9_000),
        };
        let cosign = cosign_head(&head, &[66u8; 32]);
        store.append(&cosign).unwrap();

        let reopened = JsonlCosignStore::new(path.clone());
        assert_eq!(reopened.load_all().unwrap(), vec![cosign]);
        let _ = std::fs::remove_file(&path);
    }
}
