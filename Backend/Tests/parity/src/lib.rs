//! Паритет-харнесс (next-architecture.md §7): семантическое сравнение JSON-ответов
//! двух бэкендов и доступ к кросс-языковым артефактам репозитория.

pub mod canonical_json;
pub mod semantic;

use std::path::PathBuf;

/// Корень репозитория (Backend/Tests/parity → три уровня вверх).
pub fn repo_root() -> PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .canonicalize()
        .expect("корень репозитория")
}

pub fn contract_fixtures_dir() -> PathBuf {
    repo_root().join("Artifacts").join("contract-fixtures")
}

pub fn golden_vectors_dir() -> PathBuf {
    repo_root()
        .join("Documents")
        .join("test-vectors")
        .join("backend-parity")
}

/// Вектора FIRA (FIRA.md §15): скореры четырёх компонентов + постобработка FIRA-F.
pub fn fira_vectors_dir() -> PathBuf {
    repo_root()
        .join("Documents")
        .join("test-vectors")
        .join("fira")
}

pub fn load_json(path: &std::path::Path) -> anyhow::Result<serde_json::Value> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("не удалось прочитать {}: {e}", path.display()))?;
    serde_json::from_str(&text)
        .map_err(|e| anyhow::anyhow!("некорректный JSON в {}: {e}", path.display()))
}
