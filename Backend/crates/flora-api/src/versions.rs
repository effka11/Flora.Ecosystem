//! `/version` — порт `Flora.API/FloraVersions.cs`: манифест `flora-versions.json`
//! + версия сборки + опциональный коммит из `FLORA_BUILD_COMMIT`.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Форма ответа `/version` — контракт зафиксирован фикстурой `api-version.json`.
/// null-поле `commit` сериализуется явно (§4.3 — без skip_serializing_if).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FloraVersionResponse {
    pub ecosystem: String,
    /// Ключи словаря — как в манифесте (DictionaryKeyPolicy в minimal API не применяется).
    pub products: serde_json::Map<String, serde_json::Value>,
    pub api: String,
    pub commit: Option<String>,
}

impl FloraVersionResponse {
    /// Сборка ответа. `manifest_path` — найденный `flora-versions.json` (или `VERSION`
    /// в корне репозитория — файлы синхронизированы `Scripts/sync-version.mjs`).
    pub fn build(manifest_path: Option<&Path>, build_commit: Option<&str>) -> Self {
        let (ecosystem, products) = manifest_path
            .and_then(read_manifest)
            .unwrap_or_else(|| ("unknown".to_string(), serde_json::Map::new()));

        let commit = build_commit
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .map(str::to_string);

        Self {
            ecosystem,
            products,
            // Версия бинаря; синхронизирована с VERSION.ecosystem через sync-version.mjs
            // (маркер synced-from-VERSION в Backend/Cargo.toml) — как MSBuild Version в C#.
            api: env!("CARGO_PKG_VERSION").to_string(),
            commit,
        }
    }

    /// Продакшен-вариант: поиск манифеста по стандартным местам + env.
    pub fn from_process_env() -> Self {
        let commit = std::env::var("FLORA_BUILD_COMMIT").ok();
        Self::build(locate_manifest().as_deref(), commit.as_deref())
    }
}

fn read_manifest(path: &Path) -> Option<(String, serde_json::Map<String, serde_json::Value>)> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let ecosystem = value
        .get("ecosystem")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let products = value
        .get("products")
        .and_then(|v| v.as_object())
        .map(|map| {
            map.iter()
                .filter(|(_, v)| v.as_str().is_some_and(|s| !s.trim().is_empty()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default();
    Some((ecosystem, products))
}

/// Порядок поиска манифеста версий: `FLORA_VERSIONS_PATH` → рядом с бинарём →
/// текущий каталог → корневой `VERSION` (dev-запуск из Backend/ или из корня репо).
fn locate_manifest() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("FLORA_VERSIONS_PATH") {
        let p = PathBuf::from(explicit);
        return p.exists().then_some(p);
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        candidates.push(dir.join("flora-versions.json"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("flora-versions.json"));
        candidates.push(cwd.join("VERSION"));
        candidates.push(cwd.join("..").join("VERSION"));
    }
    candidates.into_iter().find(|p| p.exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_manifest_falls_back_to_unknown_like_csharp() {
        let response = FloraVersionResponse::build(None, None);
        assert_eq!(response.ecosystem, "unknown");
        assert!(response.products.is_empty());
        assert_eq!(response.commit, None);
    }

    #[test]
    fn commit_is_trimmed_and_empty_becomes_null() {
        let with_commit = FloraVersionResponse::build(None, Some("  abc123  "));
        assert_eq!(with_commit.commit.as_deref(), Some("abc123"));
        let empty = FloraVersionResponse::build(None, Some("   "));
        assert_eq!(empty.commit, None);
    }

    #[test]
    fn null_commit_serializes_explicitly() {
        let json = serde_json::to_string(&FloraVersionResponse::build(None, None)).unwrap();
        assert!(
            json.contains("\"commit\":null"),
            "нет explicit null: {json}"
        );
    }
}
