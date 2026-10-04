//! Конфигурация с семантикой ASP.NET (next-architecture.md §4.8): те же ключи и источники.
//!
//! Модель — плоский словарь `"Секция:Ключ" → значение` (как `IConfiguration`):
//! JSON-файлы разворачиваются в пути (массивы — числовыми сегментами), env-переменные
//! в конвенции `Секция__Ключ` перекрывают файлы. Ключи регистронезависимы.
//!
//! Порядок слоёв (поздний перекрывает ранний), как в `Flora.API/Program.cs`:
//! `appsettings.json` → `appsettings.{Environment}.json` →
//! (только Development) `appsettings.Local.json` → переменные окружения.

use std::collections::HashMap;
use std::path::Path;

pub const DEVELOPMENT: &str = "Development";
pub const PRODUCTION: &str = "Production";

/// Имя окружения: `FLORA_ENVIRONMENT`, затем `ASPNETCORE_ENVIRONMENT` (совместимость
/// с деплой-скриптами VPS), по умолчанию Production — как у ASP.NET.
pub fn environment_name() -> String {
    std::env::var("FLORA_ENVIRONMENT")
        .or_else(|_| std::env::var("ASPNETCORE_ENVIRONMENT"))
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| PRODUCTION.to_string())
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("не удалось прочитать конфиг {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("некорректный JSON в {path}: {source}")]
    Json {
        path: String,
        #[source]
        source: serde_json::Error,
    },
}

#[derive(Debug, Clone, Default)]
pub struct FloraConfig {
    environment: String,
    /// Ключ — lowercase-путь ("jwt:secret"); значение None соответствует JSON null.
    entries: HashMap<String, Option<String>>,
}

impl FloraConfig {
    /// Загрузка по конвенции хоста: JSON-слои из `config_dir` + все переменные окружения.
    pub fn load(environment: &str, config_dir: &Path) -> Result<Self, ConfigError> {
        let mut layers: Vec<serde_json::Value> = Vec::new();
        push_json_layer(&mut layers, &config_dir.join("appsettings.json"))?;
        push_json_layer(
            &mut layers,
            &config_dir.join(format!("appsettings.{environment}.json")),
        )?;
        if environment.eq_ignore_ascii_case(DEVELOPMENT) {
            // Dev-only override — как appsettings.Local.json в Flora.API/Program.cs.
            push_json_layer(&mut layers, &config_dir.join("appsettings.Local.json"))?;
        }
        let env_pairs: Vec<(String, String)> = std::env::vars().collect();
        Ok(Self::from_layers(environment, &layers, &env_pairs))
    }

    /// Сборка из готовых слоёв — для тестов и встраивания.
    pub fn from_layers(
        environment: &str,
        json_layers: &[serde_json::Value],
        env_pairs: &[(String, String)],
    ) -> Self {
        let mut entries = HashMap::new();
        for layer in json_layers {
            flatten_json("", layer, &mut entries);
        }
        for (name, value) in env_pairs {
            // ASP.NET-конвенция: `__` — разделитель секций; переменные без него —
            // ключи верхнего уровня (провайдер env добавляет всё окружение).
            let key = name.replace("__", ":").to_lowercase();
            entries.insert(key, Some(value.clone()));
        }
        Self {
            environment: environment.to_string(),
            entries,
        }
    }

    pub fn environment(&self) -> &str {
        &self.environment
    }

    pub fn is_development(&self) -> bool {
        self.environment.eq_ignore_ascii_case(DEVELOPMENT)
    }

    /// Значение по пути `"Секция:Ключ"` (регистронезависимо). Пустая строка — валидное значение.
    pub fn get(&self, path: &str) -> Option<&str> {
        self.entries
            .get(&path.to_lowercase())
            .and_then(|v| v.as_deref())
    }

    /// Значение, если оно непустое после trim (частый паттерн конфигов Flora).
    pub fn get_non_empty(&self, path: &str) -> Option<&str> {
        self.get(path).map(str::trim).filter(|v| !v.is_empty())
    }

    pub fn get_bool(&self, path: &str) -> Option<bool> {
        match self.get(path)?.trim() {
            v if v.eq_ignore_ascii_case("true") => Some(true),
            v if v.eq_ignore_ascii_case("false") => Some(false),
            _ => None,
        }
    }

    pub fn get_i64(&self, path: &str) -> Option<i64> {
        self.get(path)?.trim().parse().ok()
    }

    pub fn get_f64(&self, path: &str) -> Option<f64> {
        self.get(path)?.trim().parse().ok()
    }

    /// Массив строк из индексированных детей (`path:0`, `path:1`, …) — семантика биндера .NET.
    pub fn get_string_array(&self, path: &str) -> Vec<String> {
        let prefix = format!("{}:", path.to_lowercase());
        let mut indexed: Vec<(usize, String)> = self
            .entries
            .iter()
            .filter_map(|(key, value)| {
                let rest = key.strip_prefix(&prefix)?;
                let index: usize = rest.parse().ok()?;
                Some((index, value.clone()?))
            })
            .collect();
        indexed.sort_by_key(|(index, _)| *index);
        indexed.into_iter().map(|(_, value)| value).collect()
    }

    /// Программный override поверх всех слоёв — аналог `builder.Configuration[...] = ...`
    /// в `Program.cs` (используется для эфемерного dev-секрета JWT).
    pub fn set_override(&mut self, path: &str, value: String) {
        self.entries.insert(path.to_lowercase(), Some(value));
    }

    /// Есть ли хоть один ключ в секции (аналог `GetSection(..).Exists()`).
    pub fn section_exists(&self, path: &str) -> bool {
        let lowered = path.to_lowercase();
        let prefix = format!("{lowered}:");
        self.entries
            .keys()
            .any(|k| k == &lowered || k.starts_with(&prefix))
    }
}

fn push_json_layer(layers: &mut Vec<serde_json::Value>, path: &Path) -> Result<(), ConfigError> {
    if !path.exists() {
        return Ok(());
    }
    let text = std::fs::read_to_string(path).map_err(|source| ConfigError::Io {
        path: path.display().to_string(),
        source,
    })?;
    let value = serde_json::from_str(&text).map_err(|source| ConfigError::Json {
        path: path.display().to_string(),
        source,
    })?;
    layers.push(value);
    Ok(())
}

fn flatten_json(
    prefix: &str,
    value: &serde_json::Value,
    out: &mut HashMap<String, Option<String>>,
) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                let path = join_path(prefix, key);
                flatten_json(&path, child, out);
            }
        }
        serde_json::Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                let path = join_path(prefix, &index.to_string());
                flatten_json(&path, child, out);
            }
        }
        serde_json::Value::Null => {
            out.insert(prefix.to_lowercase(), None);
        }
        // Скаляры — в строковом представлении провайдера .NET: bool как True/False,
        // числа — как в исходном JSON.
        serde_json::Value::Bool(b) => {
            out.insert(
                prefix.to_lowercase(),
                Some(if *b { "True".into() } else { "False".into() }),
            );
        }
        serde_json::Value::Number(n) => {
            out.insert(prefix.to_lowercase(), Some(n.to_string()));
        }
        serde_json::Value::String(s) => {
            out.insert(prefix.to_lowercase(), Some(s.clone()));
        }
    }
}

fn join_path(prefix: &str, key: &str) -> String {
    if prefix.is_empty() {
        key.to_string()
    } else {
        format!("{prefix}:{key}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> FloraConfig {
        FloraConfig::from_layers(
            DEVELOPMENT,
            &[
                json!({
                    "Jwt": { "Issuer": "Flora.Auth", "Secret": "", "AccessTokenMinutes": 15 },
                    "FloraWeb": { "CorsOrigins": ["http://localhost:3000", "http://localhost:3001"] },
                    "Smtp": { "EnableSsl": true, "Port": 587 },
                    "Media": { "FfprobePath": null }
                }),
                json!({ "Jwt": { "Secret": "from-env-file" } }),
            ],
            &[
                ("Jwt__Secret".into(), "from-env-var".into()),
                (
                    "ConnectionStrings__FloraDatabase".into(),
                    "Host=x;Port=5432".into(),
                ),
                (
                    "FloraWeb__CorsOrigins__0".into(),
                    "https://flora.example".into(),
                ),
            ],
        )
    }

    #[test]
    fn later_layers_override_earlier_and_env_wins() {
        let cfg = sample();
        assert_eq!(cfg.get("Jwt:Secret"), Some("from-env-var"));
        assert_eq!(cfg.get("Jwt:Issuer"), Some("Flora.Auth"));
    }

    #[test]
    fn keys_are_case_insensitive_like_aspnet() {
        let cfg = sample();
        assert_eq!(cfg.get("jwt:issuer"), Some("Flora.Auth"));
        assert_eq!(cfg.get_i64("JWT:ACCESSTOKENMINUTES"), Some(15));
    }

    #[test]
    fn env_double_underscore_maps_to_sections() {
        let cfg = sample();
        assert_eq!(
            cfg.get("ConnectionStrings:FloraDatabase"),
            Some("Host=x;Port=5432")
        );
    }

    #[test]
    fn arrays_flatten_to_indexed_keys_and_env_overrides_element() {
        let cfg = sample();
        assert_eq!(
            cfg.get_string_array("FloraWeb:CorsOrigins"),
            vec![
                "https://flora.example".to_string(),
                "http://localhost:3001".to_string()
            ],
        );
    }

    #[test]
    fn scalar_coercions_match_dotnet_provider() {
        let cfg = sample();
        assert_eq!(cfg.get("Smtp:EnableSsl"), Some("True"));
        assert_eq!(cfg.get_bool("Smtp:EnableSsl"), Some(true));
        assert_eq!(cfg.get_i64("Smtp:Port"), Some(587));
        assert_eq!(
            cfg.get("Media:FfprobePath"),
            None,
            "JSON null = отсутствие значения"
        );
        assert_eq!(cfg.get_non_empty("Jwt:Secret"), Some("from-env-var"));
    }

    #[test]
    fn section_exists_checks_children() {
        let cfg = sample();
        assert!(cfg.section_exists("FloraWeb:CorsOrigins"));
        assert!(cfg.section_exists("Jwt"));
        assert!(!cfg.section_exists("Push"));
    }

    #[test]
    fn empty_string_is_a_value_but_not_non_empty() {
        let cfg = FloraConfig::from_layers(
            PRODUCTION,
            &[json!({ "Flora": { "AdminBroadcastToken": "" } })],
            &[],
        );
        assert_eq!(cfg.get("Flora:AdminBroadcastToken"), Some(""));
        assert_eq!(cfg.get_non_empty("Flora:AdminBroadcastToken"), None);
        assert!(!cfg.is_development());
    }
}
