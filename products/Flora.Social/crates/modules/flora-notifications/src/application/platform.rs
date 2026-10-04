//! Паритет `FloraClientHeader.TryGetPlatform` и фильтры платформы inbox.

pub fn client_platform_from_header(header: Option<&str>) -> Option<String> {
    let header = header?.trim();

    if header.is_empty() {
        return None;
    }

    let platform = match header.find('/') {
        Some(slash) => &header[..slash],

        None => header,
    }
    .trim()
    .to_ascii_lowercase();

    match platform.as_str() {
        "android" | "ios" | "web" => Some(platform),

        _ => None,
    }
}

pub fn normalize_category(category: &str) -> String {
    let c = category.trim().to_ascii_lowercase();

    if c == "developer" {
        "developer".into()
    } else {
        "social".into()
    }
}

/// Паритет `NotificationInboxService.NormalizeType`.
pub fn normalize_type(notification_type: &str) -> String {
    let t = notification_type.trim().to_ascii_lowercase();
    match t.as_str() {
        "like" | "reply" | "follow" | "repost" | "developer" | "app_update" | "default" => t,
        _ => "default".into(),
    }
}

/// Types that must use `apply_social` / `retract_social` (never unkeyed `dispatch`).
pub fn requires_social_aggregation(notification_type: &str) -> bool {
    matches!(
        normalize_type(notification_type).as_str(),
        "like" | "follow" | "repost"
    )
}

pub fn normalize_category_filter(category: Option<&str>) -> Option<String> {
    let raw = category?.trim();
    if raw.is_empty() || raw.eq_ignore_ascii_case("all") {
        return None;
    }
    Some(normalize_category(raw))
}

/// Паритет `NotificationInboxService.NormalizeAudiencePlatform`.
pub fn normalize_audience_platform(platform: Option<&str>) -> Option<String> {
    let raw = platform?.trim();
    if raw.is_empty() {
        return None;
    }
    let p = raw.to_ascii_lowercase();
    match p.as_str() {
        "android" | "ios" | "web" => Some(p),
        _ => None,
    }
}

/// Паритет `NotificationInboxService.ResolveAudiencePlatform`.
pub fn resolve_audience_platform(
    notification_type: &str,
    audience_platform: Option<&str>,
) -> Option<String> {
    if let Some(normalized) = normalize_audience_platform(audience_platform) {
        return Some(normalized);
    }
    if notification_type == "app_update" {
        Some("android".into())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_client_platform() {
        assert_eq!(
            client_platform_from_header(Some("android/1.2.3")).as_deref(),
            Some("android")
        );

        assert_eq!(
            client_platform_from_header(Some("WEB")).as_deref(),
            Some("web")
        );

        assert_eq!(client_platform_from_header(Some("desktop/1")), None);

        assert_eq!(client_platform_from_header(None), None);
    }

    #[test]
    fn category_filter_all_is_none() {
        assert_eq!(normalize_category_filter(Some("all")), None);

        assert_eq!(
            normalize_category_filter(Some("developer")),
            Some("developer".into())
        );
    }

    #[test]
    fn like_follow_repost_require_social_aggregation() {
        assert!(requires_social_aggregation("like"));
        assert!(requires_social_aggregation("FOLLOW"));
        assert!(requires_social_aggregation("repost"));
        assert!(!requires_social_aggregation("reply"));
        assert!(!requires_social_aggregation("app_update"));
    }
}
