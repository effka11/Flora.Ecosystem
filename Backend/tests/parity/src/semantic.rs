//! Семантическое сравнение JSON (§4.3): даты сравниваются как моменты времени
//! (форматы долей секунды у .NET и chrono различаются), числа — с настраиваемым
//! допуском (нужен для FIRA-скоринга), null и отсутствие поля — РАЗНЫЕ вещи
//! (System.Text.Json сериализует null явно — это часть контракта).

use chrono::{DateTime, FixedOffset};
use serde_json::Value;

#[derive(Debug, Clone, Copy)]
pub struct CompareOptions {
    /// Абсолютный допуск для чисел с плавающей точкой (0.0 — строгое равенство).
    pub float_tolerance: f64,
}

impl Default for CompareOptions {
    fn default() -> Self {
        Self { float_tolerance: 0.0 }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Mismatch {
    /// JSON-путь вида `$.items[0].createdAt`.
    pub path: String,
    pub reason: String,
}

/// Возвращает список расхождений; пустой список — семантическое равенство.
pub fn diff(left: &Value, right: &Value, options: CompareOptions) -> Vec<Mismatch> {
    let mut mismatches = Vec::new();
    walk("$", left, right, options, &mut mismatches);
    mismatches
}

fn walk(path: &str, left: &Value, right: &Value, options: CompareOptions, out: &mut Vec<Mismatch>) {
    match (left, right) {
        (Value::Object(l), Value::Object(r)) => {
            for (key, lv) in l {
                match r.get(key) {
                    Some(rv) => walk(&format!("{path}.{key}"), lv, rv, options, out),
                    // null ≠ отсутствие поля: контракт сериализует null явно (§4.3).
                    None => out.push(Mismatch {
                        path: format!("{path}.{key}"),
                        reason: "поле есть слева, отсутствует справа".into(),
                    }),
                }
            }
            for key in r.keys() {
                if !l.contains_key(key) {
                    out.push(Mismatch {
                        path: format!("{path}.{key}"),
                        reason: "поле есть справа, отсутствует слева".into(),
                    });
                }
            }
        }
        (Value::Array(l), Value::Array(r)) => {
            if l.len() != r.len() {
                out.push(Mismatch {
                    path: path.to_string(),
                    reason: format!("длины массивов различаются: {} vs {}", l.len(), r.len()),
                });
                return;
            }
            for (index, (lv, rv)) in l.iter().zip(r).enumerate() {
                walk(&format!("{path}[{index}]"), lv, rv, options, out);
            }
        }
        (Value::String(l), Value::String(r)) => {
            if l == r {
                return;
            }
            // Разные байты, но, возможно, один момент времени (ISO 8601).
            if let (Some(lt), Some(rt)) = (parse_datetime(l), parse_datetime(r)) {
                if lt != rt {
                    out.push(Mismatch {
                        path: path.to_string(),
                        reason: format!("разные моменты времени: {l} vs {r}"),
                    });
                }
                return;
            }
            out.push(Mismatch {
                path: path.to_string(),
                reason: format!("строки различаются: {l:?} vs {r:?}"),
            });
        }
        (Value::Number(l), Value::Number(r)) => {
            if l == r {
                return;
            }
            let (Some(lf), Some(rf)) = (l.as_f64(), r.as_f64()) else {
                out.push(Mismatch {
                    path: path.to_string(),
                    reason: format!("числа несравнимы: {l} vs {r}"),
                });
                return;
            };
            if (lf - rf).abs() > options.float_tolerance {
                out.push(Mismatch {
                    path: path.to_string(),
                    reason: format!("числа различаются: {l} vs {r} (допуск {})", options.float_tolerance),
                });
            }
        }
        _ if left == right => {}
        _ => out.push(Mismatch {
            path: path.to_string(),
            reason: format!("типы/значения различаются: {left} vs {right}"),
        }),
    }
}

/// Дата распознаётся консервативно: только полный ISO 8601 (RFC 3339) с датой и временем —
/// чтобы обычные строки ("1.2.0", uuid) не считались датами.
fn parse_datetime(raw: &str) -> Option<DateTime<FixedOffset>> {
    if raw.len() < 19 || !raw.as_bytes().get(4).is_some_and(|b| *b == b'-') {
        return None;
    }
    DateTime::parse_from_rfc3339(raw).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn assert_equal(left: serde_json::Value, right: serde_json::Value) {
        let mismatches = diff(&left, &right, CompareOptions::default());
        assert!(mismatches.is_empty(), "неожиданные расхождения: {mismatches:?}");
    }

    fn assert_differs(left: serde_json::Value, right: serde_json::Value) {
        assert!(!diff(&left, &right, CompareOptions::default()).is_empty());
    }

    #[test]
    fn key_order_is_irrelevant() {
        assert_equal(json!({ "a": 1, "b": 2 }), json!({ "b": 2, "a": 1 }));
    }

    #[test]
    fn dotnet_and_chrono_datetime_formats_are_equal_semantically() {
        // .NET: 7 знаков долей секунды; chrono по умолчанию — без хвостовых нулей.
        assert_equal(
            json!({ "createdAt": "2026-06-12T10:00:00.0000000Z" }),
            json!({ "createdAt": "2026-06-12T10:00:00Z" }),
        );
        assert_equal(
            json!({ "at": "2026-06-12T10:00:00.500Z" }),
            json!({ "at": "2026-06-12T10:00:00.5+00:00" }),
        );
        assert_differs(
            json!({ "at": "2026-06-12T10:00:00Z" }),
            json!({ "at": "2026-06-12T10:00:01Z" }),
        );
    }

    #[test]
    fn null_differs_from_missing_field() {
        assert_differs(json!({ "videoUuid": null }), json!({}));
        assert_equal(json!({ "videoUuid": null }), json!({ "videoUuid": null }));
    }

    #[test]
    fn version_like_strings_are_not_dates() {
        assert_differs(json!({ "v": "1.2.0" }), json!({ "v": "1.2" }));
    }

    #[test]
    fn float_tolerance_applies_only_when_configured() {
        let l = json!({ "score": 0.30000000000000004 });
        let r = json!({ "score": 0.3 });
        assert!(!diff(&l, &r, CompareOptions::default()).is_empty());
        assert!(diff(&l, &r, CompareOptions { float_tolerance: 1e-9 }).is_empty());
    }

    #[test]
    fn arrays_are_ordered() {
        assert_differs(json!([1, 2]), json!([2, 1]));
        assert_differs(json!([1]), json!([1, 2]));
    }

    #[test]
    fn mismatch_paths_are_precise() {
        let mismatches = diff(
            &json!({ "items": [{ "a": 1 }] }),
            &json!({ "items": [{ "a": 2 }] }),
            CompareOptions::default(),
        );
        assert_eq!(mismatches[0].path, "$.items[0].a");
    }
}
