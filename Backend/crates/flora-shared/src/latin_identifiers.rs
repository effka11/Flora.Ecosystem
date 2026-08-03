//! Латинские идентификаторы: никнеймы и slug сообществ. Порт `Flora.Shared/LatinIdentifiers.cs`
//! — та же семантика нормализации и те же тексты сообщений (часть публичного контракта ошибок).
//!
//! Никнеймы канонически в нижнем регистре (как slug): заглавные при нормализации
//! приводятся к lowercase и в хранилище не допускаются.

pub const USERNAME_FORMAT_MESSAGE: &str =
    "Никнейм: только строчная латиница, цифры и подчёркивание.";

pub const SLUG_FORMAT_MESSAGE: &str = "Ссылка: только латиница, цифры, дефис и подчёркивание.";

pub fn is_allowed_username_char(c: char) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'
}

pub fn is_allowed_slug_char(c: char) -> bool {
    // Slug: на входе ещё допускаем A–Z (normalize_slug приводит к lower); дефис ок.
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

pub fn normalize_username(raw: Option<&str>, max_len: usize) -> String {
    let Some(raw) = raw else { return String::new() };
    if raw.trim().is_empty() {
        return String::new();
    }
    let s = raw.trim();
    let s = s.strip_prefix('@').unwrap_or(s);
    // Как slug: сначала lower, затем фильтр допустимых символов.
    let lowered = s.to_lowercase();
    let filtered: String = lowered
        .chars()
        .filter(|c| is_allowed_username_char(*c))
        .collect();
    truncate_ascii(filtered, max_len)
}

pub fn normalize_slug(raw: Option<&str>, max_len: usize) -> String {
    let Some(raw) = raw else { return String::new() };
    if raw.trim().is_empty() {
        return String::new();
    }
    // Как в C#: сначала ToLowerInvariant всей строки, затем фильтр допустимых символов.
    let lowered = raw.trim().to_lowercase();
    let filtered: String = lowered
        .chars()
        .filter(|c| is_allowed_slug_char(*c))
        .collect();
    truncate_ascii(filtered, max_len)
}

pub fn has_only_username_chars(raw: Option<&str>) -> bool {
    let Some(raw) = raw else { return false };
    if raw.trim().is_empty() {
        return false;
    }
    let s = raw.trim();
    let s = s.strip_prefix('@').unwrap_or(s);
    // Заглавные запрещены на входе (не только после normalize).
    !s.is_empty() && s.chars().all(is_allowed_username_char)
}

pub fn has_only_slug_chars(raw: Option<&str>) -> bool {
    let Some(raw) = raw else { return false };
    if raw.trim().is_empty() {
        return false;
    }
    raw.trim().chars().all(is_allowed_slug_char)
}

/// После фильтра остаются только ASCII-символы, поэтому обрезка по байтам == по символам (как в C#).
fn truncate_ascii(mut s: String, max_len: usize) -> String {
    s.truncate(max_len);
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    const USERNAME_MAX: usize = 50;
    const SLUG_MAX: usize = 100;

    #[test]
    fn normalize_username_strips_at_and_invalid_chars() {
        assert_eq!(
            normalize_username(Some("@flora_user"), USERNAME_MAX),
            "flora_user"
        );
        assert_eq!(
            normalize_username(Some("  фло flora-123  "), USERNAME_MAX),
            "flora123"
        );
        assert_eq!(normalize_username(None, USERNAME_MAX), "");
        assert_eq!(normalize_username(Some("   "), USERNAME_MAX), "");
    }

    #[test]
    fn normalize_username_lowercases() {
        assert_eq!(normalize_username(Some("Nocebo"), USERNAME_MAX), "nocebo");
        assert_eq!(
            normalize_username(Some("@Flora_User"), USERNAME_MAX),
            "flora_user"
        );
    }

    #[test]
    fn normalize_username_truncates_to_max_len() {
        let long = "a".repeat(60);
        assert_eq!(normalize_username(Some(&long), USERNAME_MAX).len(), 50);
    }

    #[test]
    fn normalize_slug_lowercases_then_filters() {
        assert_eq!(normalize_slug(Some("My-Group_1"), SLUG_MAX), "my-group_1");
        assert_eq!(normalize_slug(Some("Моя Группа x"), SLUG_MAX), "x");
        assert_eq!(normalize_slug(Some("İstanbul"), SLUG_MAX), "istanbul");
    }

    #[test]
    fn has_only_username_chars_matches_reference_semantics() {
        assert!(has_only_username_chars(Some("@flora_user")));
        assert!(has_only_username_chars(Some("flora123")));
        assert!(!has_only_username_chars(Some("Nocebo")));
        assert!(!has_only_username_chars(Some("@")));
        assert!(!has_only_username_chars(Some("фло")));
        assert!(!has_only_username_chars(Some("  ")));
        assert!(!has_only_username_chars(None));
    }

    #[test]
    fn has_only_slug_chars_allows_hyphen() {
        assert!(has_only_slug_chars(Some("my-group")));
        assert!(!has_only_slug_chars(Some("my group")));
        assert!(!has_only_slug_chars(Some("")));
    }
}
