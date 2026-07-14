//! Инфраструктура Economy: хранилище журнала и заглушка аттестора.
//!
//! Журнал — единственная персистентная сущность FEP (состояние — производное, реплеем).
//! Порт [`LedgerStore`] намеренно минимален: `load_all` + `append` — append-only по
//! построению, никакого UPDATE/DELETE в контракте нет вовсе.
//!
//! Реализации:
//! - [`InMemoryLedgerStore`] — тесты и dev;
//! - [`JsonlLedgerStore`] — reference-персистентность: одна JSON-запись на строку,
//!   `fsync` после каждого append. Postgres-store (таблица `flora_core.economy_ledger`)
//!   добавится вместе с регистрацией в `flora-migrate` (см. FEP.md §12).

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use flora_economy_crypto::ledger::LedgerEntry;

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
        let text = match std::fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let mut entries = Vec::new();
        for (i, line) in text.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let entry: LedgerEntry =
                serde_json::from_str(line).map_err(|e| StoreError::Corrupt {
                    line: i + 1,
                    reason: e.to_string(),
                })?;
            entries.push(entry);
        }
        Ok(entries)
    }

    fn append(&self, entry: &LedgerEntry) -> Result<(), StoreError> {
        let _guard = self.write_lock.lock().expect("mutex не отравлен");
        let json = serde_json::to_string(entry).map_err(|e| StoreError::Corrupt {
            line: 0,
            reason: e.to_string(),
        })?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        writeln!(file, "{json}")?;
        // Журнал — источник истины; потеря хвоста при сбое недопустима.
        file.sync_data()?;
        Ok(())
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
}
