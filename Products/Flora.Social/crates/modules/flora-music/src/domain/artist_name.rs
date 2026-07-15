//! Нормализация имени исполнителя — паритет с MusicArtistNameNormalizer (C#).

/// `MusicArtistNameNormalizer.IsValidDisplayName`.
pub fn is_valid_display_name(display_name: &str) -> bool {
    !display_name.trim().is_empty()
}

/// Trim → lowercase → collapse whitespace (как `\s+` → одиночный пробел).
pub fn normalize(display_name: &str) -> String {
    let trimmed = display_name.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let lower = trimmed.to_lowercase();
    collapse_whitespace(&lower)
}

fn collapse_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{is_valid_display_name, normalize};

    #[test]
    fn normalize_collapses_and_lowercases() {
        assert_eq!(normalize("  Flora   Artist  "), "flora artist");
        assert_eq!(normalize("\tA\nB"), "a b");
        assert_eq!(normalize("   "), "");
    }

    #[test]
    fn is_valid_rejects_blank() {
        assert!(!is_valid_display_name(""));
        assert!(!is_valid_display_name("   "));
        assert!(is_valid_display_name("A"));
    }
}
