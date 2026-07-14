//! Порт `ReservedUsernames.cs` — exact + prefixes + collapse `_`.

use flora_shared::latin_identifiers::normalize_username;

use super::reserved_data;

pub fn is_reserved(raw: &str) -> bool {
    let normalized = normalize_username(Some(raw), 50);
    if normalized.is_empty() {
        return false;
    }
    let lower = normalized.to_ascii_lowercase();
    if reserved_data::EXACT.iter().any(|e| e.eq_ignore_ascii_case(&lower)) {
        return true;
    }
    let collapsed: String = lower.chars().filter(|c| *c != '_').collect();
    if collapsed != lower
        && reserved_data::EXACT
            .iter()
            .any(|e| e.eq_ignore_ascii_case(&collapsed))
    {
        return true;
    }
    reserved_data::PREFIXES
        .iter()
        .any(|p| lower.starts_with(&p.to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_is_reserved() {
        assert!(is_reserved("admin"));
        assert!(is_reserved("Admin"));
        assert!(is_reserved("flora_team"));
    }

    #[test]
    fn ordinary_name_ok() {
        assert!(!is_reserved("egor_dev"));
    }
}
