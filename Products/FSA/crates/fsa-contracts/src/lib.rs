//! FSA contracts — types owned by the functional product (not Social modules).
//! Spec: `Documents/fsa/FSA.md`. Social composition maps FIRA-derived signals into
//! [`AffinitySnapshot`]; Users persists [`SearchPreferences`] and maps into the DTO.
//! FSA itself does not depend on FIRA crates: the bridge is this data contract.

use serde::{Deserialize, Serialize};

/// Уровень индивидуальности поиска `α ∈ [0, 1]` (FSA.md §5).
///
/// `0` — отсутствие индивидуального поиска (никакой интеграции с FIRA;
/// выдача бит-в-бит воспроизводима для любых пользователей),
/// `1` — максимальный уровень персонализации. Значения вне диапазона
/// зажимаются; `NaN` трактуется как `0`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(from = "f64", into = "f64")]
pub struct PersonalizationLevel(f64);

impl PersonalizationLevel {
    pub const OFF: Self = Self(0.0);
    pub const MAX: Self = Self(1.0);

    /// Зажимает значение в `[0, 1]`; `NaN` → `0`.
    pub fn new(raw: f64) -> Self {
        if raw.is_nan() {
            return Self(0.0);
        }
        Self(raw.clamp(0.0, 1.0))
    }

    pub const fn value(self) -> f64 {
        self.0
    }

    /// `true` ⇔ персонализация полностью выключена (инвариант α=0, FSA.md §5.3).
    pub fn is_off(self) -> bool {
        self.0 == 0.0
    }
}

impl Default for PersonalizationLevel {
    /// Продуктовый дефолт — максимальная индивидуальность (FSA.md §5.1).
    fn default() -> Self {
        Self::MAX
    }
}

impl From<f64> for PersonalizationLevel {
    fn from(raw: f64) -> Self {
        Self::new(raw)
    }
}

impl From<PersonalizationLevel> for f64 {
    fn from(level: PersonalizationLevel) -> Self {
        level.value()
    }
}

/// Поверхность поиска (модуль FSA-X). Идентификаторы стабильны и входят в
/// публичный контракт (ключи кэша, метрики, API-маршруты).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchDomain {
    /// FSA-F — посты ленты.
    Feed,
    /// FSA-A — музыка (треки/артисты/альбомы).
    Audio,
    /// FSA-M — сообщения (E2E; индекс живёт на клиенте).
    Messages,
    /// FSA-P — люди.
    People,
    /// FSA-C — сообщества.
    Communities,
    /// FSA-N — уведомления.
    Notifications,
    /// FSA-D — черновики.
    Drafts,
}

impl SearchDomain {
    pub const ALL: [Self; 7] = [
        Self::Feed,
        Self::Audio,
        Self::Messages,
        Self::People,
        Self::Communities,
        Self::Notifications,
        Self::Drafts,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Feed => "feed",
            Self::Audio => "audio",
            Self::Messages => "messages",
            Self::People => "people",
            Self::Communities => "communities",
            Self::Notifications => "notifications",
            Self::Drafts => "drafts",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "feed" => Some(Self::Feed),
            "audio" => Some(Self::Audio),
            "messages" => Some(Self::Messages),
            "people" => Some(Self::People),
            "communities" => Some(Self::Communities),
            "notifications" => Some(Self::Notifications),
            "drafts" => Some(Self::Drafts),
            _ => None,
        }
    }
}

/// Одна запись аффинити: намespaced-ключ (см. [`affinity_key`]) → сила `[0, 1]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AffinityEntry {
    pub key: String,
    pub weight: f64,
}

/// Снимок аффинити пользователя — мост FIRA → FSA (FSA.md §5.2).
///
/// Composition-слой Social собирает снимок из данных FIRA (UIP, author affinity,
/// социальный граф) и передаёт его в FSA вместе с запросом. FSA не знает,
/// как снимок построен, — только словарь ключей нормативен.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AffinitySnapshot {
    pub entries: Vec<AffinityEntry>,
    /// Unix-секунды момента сборки; `None` — не отслеживается.
    pub generated_at: Option<i64>,
}

impl AffinitySnapshot {
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Копия с весами, зажатыми в `[0, 1]`; записи с `NaN` отбрасываются.
    pub fn normalized(&self) -> Self {
        Self {
            entries: self
                .entries
                .iter()
                .filter(|e| !e.weight.is_nan())
                .map(|e| AffinityEntry {
                    key: e.key.clone(),
                    weight: e.weight.clamp(0.0, 1.0),
                })
                .collect(),
            generated_at: self.generated_at,
        }
    }
}

/// Нормативный словарь ключей аффинити (FSA.md §5.2). И построитель снимка
/// (composition), и модули FSA обязаны использовать эти конструкторы —
/// строковый формат ключей является контрактом.
pub mod affinity_key {
    /// Автор контента (посты, репосты).
    pub fn author(id: &str) -> String {
        format!("author:{id}")
    }

    /// Пользователь как субъект (FSA-P: сила связи с кандидатом).
    pub fn user(id: &str) -> String {
        format!("user:{id}")
    }

    /// Сообщество (принадлежность/интерес).
    pub fn community(id: &str) -> String {
        format!("community:{id}")
    }

    /// Тема из таксономии FIRA (`InterestProfile.topics`).
    pub fn topic(id: &str) -> String {
        format!("topic:{id}")
    }

    /// Музыкальный артист (FSA-A).
    pub fn artist(id: &str) -> String {
        format!("artist:{id}")
    }

    /// Музыкальный жанр (FSA-A).
    pub fn genre(id: &str) -> String {
        format!("genre:{id}")
    }

    /// Отправитель сообщения (FSA-M; строится на клиенте).
    pub fn sender(id: &str) -> String {
        format!("sender:{id}")
    }

    /// Диалог (FSA-M; строится на клиенте).
    pub fn conversation(id: &str) -> String {
        format!("conversation:{id}")
    }

    /// Инициатор уведомления (FSA-N).
    pub fn actor(id: &str) -> String {
        format!("actor:{id}")
    }

    /// Контентный тег (FSA-F).
    pub fn tag(slug: &str) -> String {
        format!("tag:{slug}")
    }
}

/// Пользовательские настройки поиска. Персистенс — Social Users; kernel
/// получает уже готовый DTO. `Default` = продуктовый дефолт.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPreferences {
    /// Уровень индивидуальности α (FSA.md §5). Настройка пользователя сильнее
    /// глобальных дефолтов (инвариант суверенитета, FGP §1.2 п. 2).
    pub personalization: PersonalizationLevel,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn personalization_level_clamps() {
        assert_eq!(PersonalizationLevel::new(-0.5).value(), 0.0);
        assert_eq!(PersonalizationLevel::new(1.5).value(), 1.0);
        assert_eq!(PersonalizationLevel::new(0.37).value(), 0.37);
        assert_eq!(PersonalizationLevel::new(f64::NAN).value(), 0.0);
        assert!(PersonalizationLevel::OFF.is_off());
        assert!(!PersonalizationLevel::MAX.is_off());
    }

    #[test]
    fn personalization_level_default_is_max() {
        assert_eq!(PersonalizationLevel::default(), PersonalizationLevel::MAX);
        assert_eq!(
            SearchPreferences::default().personalization,
            PersonalizationLevel::MAX
        );
    }

    #[test]
    fn personalization_level_serde_clamps_on_deserialize() {
        let level: PersonalizationLevel = serde_json::from_str("7.5").expect("deserialize");
        assert_eq!(level.value(), 1.0);
        let json = serde_json::to_string(&PersonalizationLevel::new(0.25)).expect("serialize");
        assert_eq!(json, "0.25");
    }

    #[test]
    fn search_domain_roundtrip() {
        for domain in SearchDomain::ALL {
            assert_eq!(SearchDomain::parse(domain.as_str()), Some(domain));
        }
        assert_eq!(SearchDomain::parse(" FEED "), Some(SearchDomain::Feed));
        assert_eq!(SearchDomain::parse("unknown"), None);
    }

    #[test]
    fn affinity_snapshot_normalizes() {
        let snapshot = AffinitySnapshot {
            entries: vec![
                AffinityEntry {
                    key: affinity_key::author("a1"),
                    weight: 2.0,
                },
                AffinityEntry {
                    key: affinity_key::topic("music"),
                    weight: -1.0,
                },
                AffinityEntry {
                    key: affinity_key::tag("rust"),
                    weight: f64::NAN,
                },
            ],
            generated_at: Some(1_700_000_000),
        };
        let normalized = snapshot.normalized();
        assert_eq!(normalized.entries.len(), 2);
        assert_eq!(normalized.entries[0].weight, 1.0);
        assert_eq!(normalized.entries[1].weight, 0.0);
        assert_eq!(normalized.generated_at, Some(1_700_000_000));
    }

    #[test]
    fn affinity_keys_are_namespaced() {
        assert_eq!(affinity_key::author("42"), "author:42");
        assert_eq!(affinity_key::conversation("c-9"), "conversation:c-9");
        assert_eq!(affinity_key::genre("rock"), "genre:rock");
    }

    #[test]
    fn preferences_serde_uses_camel_case() {
        let prefs = SearchPreferences::default();
        let json = serde_json::to_value(prefs).expect("serialize");
        assert_eq!(json["personalization"], 1.0);
    }
}
