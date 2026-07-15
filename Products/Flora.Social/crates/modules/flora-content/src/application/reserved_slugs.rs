//! Зарезервированные slug сообществ — порт `CommunityReservedSlugs.cs`.

#[path = "reserved_slugs_data.rs"]
mod reserved_slugs_data;

use flora_shared::latin_identifiers::normalize_slug;

use reserved_slugs_data::{EXACT, PREFIXES};

pub fn collapse_separators(slug: &str) -> String {
    slug.replace(['-', '_'], "")
}

/// `normalized_slug` уже в нижнем регистре (как после `normalize_slug`).
pub fn is_reserved(normalized_slug: &str) -> bool {
    if normalized_slug.is_empty() {
        return true;
    }
    if EXACT.contains(&normalized_slug) {
        return true;
    }
    let collapsed = collapse_separators(normalized_slug);
    if collapsed != normalized_slug && EXACT.contains(&collapsed.as_str()) {
        return true;
    }
    PREFIXES
        .iter()
        .any(|prefix| normalized_slug.starts_with(prefix))
}

pub fn normalize_for_compare(raw: Option<&str>) -> String {
    normalize_slug(raw, 100)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_exact_and_prefix() {
        assert!(is_reserved("admin"));
        assert!(is_reserved("flora-official"));
        assert!(is_reserved("ad-min"));
        assert!(!is_reserved("my-cool-group"));
    }
}
