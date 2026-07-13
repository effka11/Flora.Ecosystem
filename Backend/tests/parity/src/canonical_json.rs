//! Canonical JSON для подписи FSCP-конверта (docs/fscp/FSCP.md §Canonical encoding) —
//! байт-паритет с TS `canonicalJson.ts`: рекурсивная сортировка ключей объектов,
//! массивы в исходном порядке, экранирование строк как `JSON.stringify`.
//!
//! Сортировка — побайтово по UTF-8 (`str::cmp`). Для ASCII-ключей v1 это совпадает
//! с UTF-16 code-unit порядком TS; расхождение возможно только при смешении
//! BMP-символов ≥ U+E000 с астральными в именах ключей — v1 такие имена запрещает.
//! Числа v1 — только целые (`version: 1`); float-паритет с JS не гарантируется
//! и unit-тестом зафиксирован как незадействованный.
//!
//! Живёт в паритет-харнессе: сервер canonical не вычисляет (§4.4 — только форма),
//! это задел будущего Rust client-core, доказанный на golden-транскрипте.

use serde_json::Value;

/// Сериализует `Value` в canonical-строку. Требует serde_json с `preserve_order`
/// (workspace-конфигурация) — исходный порядок ключей не важен, всё сортируется.
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&n.to_string()),
        Value::String(s) => out.push_str(&escape_like_json_stringify(s)),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_unstable();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&escape_like_json_stringify(k));
                out.push(':');
                write_canonical(&map[k.as_str()], out);
            }
            out.push('}');
        }
    }
}

/// `JSON.stringify` для строки: короткие формы `\" \\ \b \t \n \f \r`,
/// прочие управляющие — `\u00xx`, не-ASCII — как есть (UTF-8).
/// serde_json::to_string даёт тот же результат; собственная реализация
/// исключает зависимость поведения от версии serde_json.
fn escape_like_json_stringify(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{0C}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::canonical_json;
    use serde_json::json;

    // Зеркало TS canonicalJson.test.ts — одинаковые входы, одинаковые golden-строки.

    #[test]
    fn sorts_keys_by_code_unit_not_locale() {
        // "B" (0x42) < "a" (0x61) < "b" (0x62); ICU-сортировка дала бы a, b, B.
        let v = json!({"b": 1, "a": 2, "B": 3});
        assert_eq!(canonical_json(&v), r#"{"B":3,"a":2,"b":1}"#);
    }

    #[test]
    fn nested_envelope_like_object_matches_ts_golden() {
        let v = json!({
            "version": 1,
            "recipients": [
                {"userUuid": "AAAA", "recipientKeyEnvelope": {"preKeyId": null, "version": 1}},
                {"userUuid": "bbbb", "recipientKeyEnvelope": {"preKeyId": null, "version": 1}},
            ],
            "aead": {"nonceBase64Url": "n0", "name": "xchacha20-poly1305"},
            "createdAt": "2026-01-01T00:00:00.000Z",
        });
        assert_eq!(
            canonical_json(&v),
            concat!(
                r#"{"aead":{"name":"xchacha20-poly1305","nonceBase64Url":"n0"},"#,
                r#""createdAt":"2026-01-01T00:00:00.000Z","#,
                r#""recipients":[{"recipientKeyEnvelope":{"preKeyId":null,"version":1},"userUuid":"AAAA"},"#,
                r#"{"recipientKeyEnvelope":{"preKeyId":null,"version":1},"userUuid":"bbbb"}],"#,
                r#""version":1}"#,
            ),
        );
    }

    #[test]
    fn arrays_keep_order_and_strings_escape_like_json_stringify() {
        assert_eq!(canonical_json(&json!([3, 1, 2])), "[3,1,2]");
        assert_eq!(
            canonical_json(&json!({"s": "кириллица \"q\" \n"})),
            "{\"s\":\"кириллица \\\"q\\\" \\n\"}",
        );
        // Управляющий символ вне коротких форм — \u00xx в нижнем регистре, как в JS.
        assert_eq!(canonical_json(&json!({"c": "\u{01}"})), r#"{"c":"\u0001"}"#);
    }

    #[test]
    fn integers_match_js_number_formatting() {
        // v1 использует только целые; этого паритета достаточно.
        assert_eq!(
            canonical_json(&json!({"version": 1, "n": 0})),
            r#"{"n":0,"version":1}"#
        );
    }
}
