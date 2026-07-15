//! Прогон contract fixtures (§7.2): все фикстуры — валидный JSON и соблюдают
//! контрактные инварианты §4.3 (camelCase, GUID lowercase, парсящиеся ISO-даты).
//! Формы конкретных эндпоинтов сверяются в тестах модулей по мере их переноса
//! (для хост-эндпоинтов — Backend/crates/flora-api/tests/host_parity.rs).

use flora_parity::{contract_fixtures_dir, load_json};

fn all_fixtures() -> Vec<(String, serde_json::Value)> {
    let dir = contract_fixtures_dir();
    let mut result = Vec::new();
    for entry in std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("нет каталога фикстур {}: {e}", dir.display()))
    {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "json") {
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            result.push((name, load_json(&path).unwrap()));
        }
    }
    assert!(
        result.len() >= 8,
        "ожидались фикстуры в Artifacts/contract-fixtures"
    );
    result
}

#[test]
fn fixtures_exist_and_are_valid_json() {
    let names: Vec<String> = all_fixtures().into_iter().map(|(n, _)| n).collect();
    for required in [
        "api-root.json",
        "api-health.json",
        "api-version.json",
        "auth-login.json",
        "feed-page.json",
        "messaging-conversations.json",
    ] {
        assert!(
            names.iter().any(|n| n == required),
            "нет обязательной фикстуры {required}"
        );
    }
}

#[test]
fn object_keys_are_camel_case() {
    fn check(name: &str, value: &serde_json::Value) {
        match value {
            serde_json::Value::Object(map) => {
                for (key, child) in map {
                    assert!(
                        key.chars().next().is_some_and(|c| c.is_ascii_lowercase()),
                        "{name}: ключ {key:?} не camelCase",
                    );
                    check(name, child);
                }
            }
            serde_json::Value::Array(items) => items.iter().for_each(|i| check(name, i)),
            _ => {}
        }
    }
    for (name, value) in all_fixtures() {
        check(&name, &value);
    }
}

#[test]
fn uuid_like_strings_are_lowercase_hyphenated() {
    fn walk(name: &str, value: &serde_json::Value) {
        match value {
            serde_json::Value::String(s) if s.len() == 36 && s.parse::<uuid::Uuid>().is_ok() => {
                assert_eq!(
                    s,
                    &s.to_lowercase(),
                    "{name}: GUID обязан быть lowercase (§4.2)"
                );
            }
            serde_json::Value::Object(map) => map.values().for_each(|v| walk(name, v)),
            serde_json::Value::Array(items) => items.iter().for_each(|v| walk(name, v)),
            _ => {}
        }
    }
    for (name, value) in all_fixtures() {
        walk(&name, &value);
    }
}

#[test]
fn datetime_fields_parse_as_utc_iso8601() {
    fn walk(name: &str, key: Option<&str>, value: &serde_json::Value) {
        match value {
            serde_json::Value::String(s)
                if key.is_some_and(|k| k.ends_with("At") || k == "createdAt") =>
            {
                let parsed = chrono::DateTime::parse_from_rfc3339(s);
                assert!(parsed.is_ok(), "{name}: поле {key:?} не ISO 8601: {s}");
            }
            serde_json::Value::Object(map) => {
                map.iter().for_each(|(k, v)| walk(name, Some(k), v));
            }
            serde_json::Value::Array(items) => items.iter().for_each(|v| walk(name, key, v)),
            _ => {}
        }
    }
    for (name, value) in all_fixtures() {
        walk(&name, None, &value);
    }
}
