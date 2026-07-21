//! FIRA contracts — types owned by the functional product (not Users/Content modules).
//! Spec: `Documents/fira/FIRA.md`. Users persists UIP and maps into [`InterestProfile`];
//! Content persists feed settings and maps into [`FeedPreferences`].

use serde::{Deserialize, Serialize};

/// User Interest Profile (UIP) — shared across FIRA-F/P/C/M.
/// Persistence stays in Social Users; this DTO is the portable contract.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct InterestProfile {
    /// Topic weights or opaque feature vector entries (v1 may be empty / Phase-0 unused).
    pub topics: Vec<InterestTopicWeight>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InterestTopicWeight {
    pub topic_id: String,
    pub weight: f64,
}

/// Баланс «свежее ↔ популярное» (FIRA-F §User Controls): управляет λ затухания GlobalRelevance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FeedFreshness {
    /// λ = 0.10 — полужизнь ≈ 7 ч, лента заметно «свежее».
    Fresh,
    /// Базовый конфиг (λ = 0.05, полужизнь ≈ 14 ч).
    Balanced,
    /// λ = 0.025 — полужизнь ≈ 28 ч, виральное живёт дольше.
    Popular,
}

/// Доля exploration-квоты ε (FIRA.md §5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExplorationLevel {
    /// ε = 0 — без случайных открытий.
    Off,
    /// ε = 0.08.
    Low,
    /// Базовый конфиг (ε = 0.15).
    Standard,
    /// ε = 0.25.
    High,
}

/// Что делать с уже просмотренными постами в рекомендациях.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SeenPostsMode {
    /// Показывать как обычно (поведение v1 до User Controls).
    Show,
    /// Демотировать: Score × seen_demotion_factor.
    Demote,
    /// Исключать из кандидатного пула (аварийный добор последних постов не фильтруется,
    /// чтобы лента не оказалась пустой).
    Hide,
}

/// Ограничение серий одного автора (§Шаг 4 FIRA-F.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthorDiversity {
    /// Не более 1 поста автора подряд.
    Strict,
    /// Базовый конфиг (2 подряд).
    Standard,
    /// Без ограничения серий.
    Off,
}

/// Настройки ленты пользователя (FIRA-F). Персистенс — Social Content
/// (`flora_core.user_feed_settings`); kernel применяет через
/// `fira_core::feed::apply_preferences`. `Default` обязан воспроизводить
/// поведение ленты без настроек (кроме `seen_posts`: продуктовый дефолт —
/// `Demote`, см. FIRA-F.md §User Controls).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedPreferences {
    pub freshness: FeedFreshness,
    pub exploration: ExplorationLevel,
    /// false → репостный пул исключается, repost-boost выключен; действует и на «Подписки».
    pub show_reposts: bool,
    /// false → посты сообществ пользователя не попадают в рекомендации.
    pub community_posts: bool,
    pub seen_posts: SeenPostsMode,
    pub author_diversity: AuthorDiversity,
}

impl Default for FeedPreferences {
    fn default() -> Self {
        Self {
            freshness: FeedFreshness::Balanced,
            exploration: ExplorationLevel::Standard,
            show_reposts: true,
            community_posts: true,
            seen_posts: SeenPostsMode::Demote,
            author_diversity: AuthorDiversity::Standard,
        }
    }
}

impl FeedFreshness {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Fresh => "fresh",
            Self::Balanced => "balanced",
            Self::Popular => "popular",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "fresh" => Some(Self::Fresh),
            "balanced" => Some(Self::Balanced),
            "popular" => Some(Self::Popular),
            _ => None,
        }
    }
}

impl ExplorationLevel {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Low => "low",
            Self::Standard => "standard",
            Self::High => "high",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "off" => Some(Self::Off),
            "low" => Some(Self::Low),
            "standard" => Some(Self::Standard),
            "high" => Some(Self::High),
            _ => None,
        }
    }
}

impl SeenPostsMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Show => "show",
            Self::Demote => "demote",
            Self::Hide => "hide",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "show" => Some(Self::Show),
            "demote" => Some(Self::Demote),
            "hide" => Some(Self::Hide),
            _ => None,
        }
    }
}

impl AuthorDiversity {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Strict => "strict",
            Self::Standard => "standard",
            Self::Off => "off",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "strict" => Some(Self::Strict),
            "standard" => Some(Self::Standard),
            "off" => Some(Self::Off),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enums_roundtrip_via_str() {
        for v in [
            FeedFreshness::Fresh,
            FeedFreshness::Balanced,
            FeedFreshness::Popular,
        ] {
            assert_eq!(FeedFreshness::parse(v.as_str()), Some(v));
        }
        for v in [
            ExplorationLevel::Off,
            ExplorationLevel::Low,
            ExplorationLevel::Standard,
            ExplorationLevel::High,
        ] {
            assert_eq!(ExplorationLevel::parse(v.as_str()), Some(v));
        }
        for v in [
            SeenPostsMode::Show,
            SeenPostsMode::Demote,
            SeenPostsMode::Hide,
        ] {
            assert_eq!(SeenPostsMode::parse(v.as_str()), Some(v));
        }
        for v in [
            AuthorDiversity::Strict,
            AuthorDiversity::Standard,
            AuthorDiversity::Off,
        ] {
            assert_eq!(AuthorDiversity::parse(v.as_str()), Some(v));
        }
    }

    #[test]
    fn parse_is_case_insensitive_and_trims() {
        assert_eq!(FeedFreshness::parse("  Fresh "), Some(FeedFreshness::Fresh));
        assert_eq!(SeenPostsMode::parse("DEMOTE"), Some(SeenPostsMode::Demote));
        assert_eq!(FeedFreshness::parse("unknown"), None);
    }

    #[test]
    fn serde_uses_camel_case_wire_format() {
        let prefs = FeedPreferences::default();
        let json = serde_json::to_value(prefs).expect("serialize");
        assert_eq!(json["freshness"], "balanced");
        assert_eq!(json["showReposts"], true);
        assert_eq!(json["seenPosts"], "demote");
        assert_eq!(json["authorDiversity"], "standard");
    }
}
