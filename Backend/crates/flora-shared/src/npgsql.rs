//! Парсер строки подключения в формате Npgsql (`Host=...;Port=...;Search Path=...`).
//!
//! Деплой передаёт `ConnectionStrings__FloraDatabase` в формате .NET (§4.8 — те же ключи
//! и значения окружения); Rust-сторона обязана понимать его как есть. Маппинг в опции
//! конкретного драйвера (sqlx) живёт у потребителя — здесь только разбор строки.

use std::collections::HashMap;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NpgsqlConnectionString {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    /// `Search Path` — schema search_path (у Flora всегда `flora_core`).
    pub search_path: Option<String>,
    /// `SSL Mode` — Disable/Allow/Prefer/Require (регистр не важен).
    pub ssl_mode: Option<String>,
    /// Остальные пары как есть (Include Error Detail и пр.).
    pub extra: HashMap<String, String>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum NpgsqlParseError {
    #[error("пара без '=' в строке подключения: {0}")]
    MissingEquals(String),
    #[error("некорректный Port: {0}")]
    InvalidPort(String),
}

impl NpgsqlConnectionString {
    /// Разбор `Key=Value;...`: ключи регистронезависимы, пробелы вокруг '='/';' игнорируются,
    /// пустые сегменты допустимы (хвостовой ';').
    pub fn parse(raw: &str) -> Result<Self, NpgsqlParseError> {
        let mut result = Self::default();
        for segment in raw.split(';') {
            let segment = segment.trim();
            if segment.is_empty() {
                continue;
            }
            let Some((key, value)) = segment.split_once('=') else {
                return Err(NpgsqlParseError::MissingEquals(segment.to_string()));
            };
            let key_norm = key.trim().to_lowercase();
            let value = value.trim().to_string();
            match key_norm.as_str() {
                "host" | "server" => result.host = Some(value),
                "port" => {
                    result.port = Some(
                        value
                            .parse()
                            .map_err(|_| NpgsqlParseError::InvalidPort(value.clone()))?,
                    );
                }
                "database" | "db" => result.database = Some(value),
                "username" | "user id" | "userid" | "user" => result.username = Some(value),
                "password" => result.password = Some(value),
                "search path" | "searchpath" => result.search_path = Some(value),
                "ssl mode" | "sslmode" => result.ssl_mode = Some(value),
                _ => {
                    result.extra.insert(key.trim().to_string(), value);
                }
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_flora_connection_string() {
        let parsed = NpgsqlConnectionString::parse(
            "Host=localhost;Port=5432;Database=flora_social;Username=flora;Password=change-me;\
             Include Error Detail=true;Search Path=flora_core",
        )
        .unwrap();
        assert_eq!(parsed.host.as_deref(), Some("localhost"));
        assert_eq!(parsed.port, Some(5432));
        assert_eq!(parsed.database.as_deref(), Some("flora_social"));
        assert_eq!(parsed.username.as_deref(), Some("flora"));
        assert_eq!(parsed.password.as_deref(), Some("change-me"));
        assert_eq!(parsed.search_path.as_deref(), Some("flora_core"));
        assert_eq!(parsed.extra.get("Include Error Detail").map(String::as_str), Some("true"));
    }

    #[test]
    fn parses_prod_style_with_ssl_mode_and_trailing_semicolon() {
        let parsed =
            NpgsqlConnectionString::parse("Host=10.0.0.1;SSL Mode=Prefer;Search Path=flora_core;")
                .unwrap();
        assert_eq!(parsed.ssl_mode.as_deref(), Some("Prefer"));
        assert_eq!(parsed.search_path.as_deref(), Some("flora_core"));
    }

    #[test]
    fn keys_are_case_insensitive() {
        let parsed = NpgsqlConnectionString::parse("HOST=h;pOrT=1;database=d").unwrap();
        assert_eq!(parsed.host.as_deref(), Some("h"));
        assert_eq!(parsed.port, Some(1));
        assert_eq!(parsed.database.as_deref(), Some("d"));
    }

    #[test]
    fn rejects_malformed_segments() {
        assert_eq!(
            NpgsqlConnectionString::parse("Host"),
            Err(NpgsqlParseError::MissingEquals("Host".into())),
        );
        assert_eq!(
            NpgsqlConnectionString::parse("Port=abc"),
            Err(NpgsqlParseError::InvalidPort("abc".into())),
        );
    }
}
