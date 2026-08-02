//! FSA-C — поиск сообществ. Спека: `Documents/fsa/FSA-C.md`.
//! Владелец данных — Social Content. Индексируются только карточки
//! (имя/описание/теги); контент приватных сообществ в FSA-C не попадает.

use fsa_contracts::{PersonalizationLevel, SearchDomain, affinity_key};

use crate::document::Document;
use crate::engine::{SearchEngine, SearchFilters, SearchRequest, SearchResponse};
use crate::error::FsaError;
use crate::personalization::PersonalizationContext;
use crate::profile::{
    EngineLimits, ExpansionPolicy, FieldSpec, PersonalizationPolicy, RankingParams, RecencyMode,
    SearchProfile,
};

pub const FIELD_NAME: &str = "name";
pub const FIELD_DESCRIPTION: &str = "description";
pub const FIELD_TAGS: &str = "tags";

pub const ATTR_TOPIC: &str = "topic";
pub const ATTR_LANG: &str = "lang";
pub const ATTR_PRIVATE: &str = "private";

/// Нормативный профиль FSA-C (FSA-C.md §Профиль).
pub fn profile() -> SearchProfile {
    SearchProfile {
        domain: SearchDomain::Communities,
        fields: vec![
            FieldSpec::new(FIELD_NAME, 2.2).positions().exact_boost(0.8),
            FieldSpec::new(FIELD_DESCRIPTION, 0.8),
            FieldSpec::new(FIELD_TAGS, 1.4),
        ],
        ranking: RankingParams {
            k1: 1.2,
            recency: RecencyMode::Boost {
                half_life_secs: 60 * 24 * 3600,
                weight: 0.15,
            },
            static_rank_weight: 0.6,
            proximity_weight: 0.1,
        },
        expansion: ExpansionPolicy {
            prefix_min_chars: 2,
            fuzzy_min_chars: 4,
            ..ExpansionPolicy::default()
        },
        personalization: PersonalizationPolicy { lambda: 0.8 },
        limits: EngineLimits::default(),
    }
}

/// Карточка сообщества — вход индексации FSA-C.
#[derive(Debug, Clone, PartialEq)]
pub struct CommunityDoc {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub tags: Vec<String>,
    /// Тема таксономии FIRA.
    pub topic_id: Option<String>,
    pub lang: Option<String>,
    pub is_private: bool,
    /// Unix-секунды последней активности в сообществе.
    pub last_activity_at: i64,
    /// Нормированное здоровье/размер `[0, 1]` (глобальный приор).
    pub size_rank: f64,
}

impl CommunityDoc {
    fn into_document(self) -> Document {
        let mut doc = Document::new(self.id.clone())
            .timestamp(self.last_activity_at)
            .static_rank(self.size_rank)
            .field(FIELD_NAME, self.name)
            .attr(ATTR_PRIVATE, bool_attr(self.is_private))
            .personal_key(affinity_key::community(&self.id));
        if let Some(description) = self.description {
            doc = doc.field(FIELD_DESCRIPTION, description);
        }
        for tag in self.tags {
            doc = doc.field(FIELD_TAGS, tag);
        }
        if let Some(topic_id) = self.topic_id {
            doc = doc
                .attr(ATTR_TOPIC, topic_id.clone())
                .personal_key(affinity_key::topic(&topic_id));
        }
        if let Some(lang) = self.lang {
            doc = doc.attr(ATTR_LANG, lang);
        }
        doc
    }
}

fn bool_attr(value: bool) -> &'static str {
    if value { "true" } else { "false" }
}

/// Параметры поиска FSA-C.
#[derive(Debug, Clone, PartialEq)]
pub struct CommunitiesQuery {
    pub query: String,
    pub limit: usize,
    pub offset: usize,
    pub now: i64,
    pub personalization: PersonalizationLevel,
    pub topic_id: Option<String>,
    pub lang: Option<String>,
    /// `true` — исключить приватные сообщества из выдачи.
    pub exclude_private: bool,
}

impl CommunitiesQuery {
    pub fn new(query: impl Into<String>, now: i64) -> Self {
        Self {
            query: query.into(),
            limit: 20,
            offset: 0,
            now,
            personalization: PersonalizationLevel::OFF,
            topic_id: None,
            lang: None,
            exclude_private: false,
        }
    }
}

/// Поисковый движок FSA-C.
pub struct CommunitiesSearch {
    engine: SearchEngine,
}

impl CommunitiesSearch {
    pub fn new() -> Self {
        Self {
            engine: SearchEngine::new(profile()).expect("FSA-C profile is valid"),
        }
    }

    pub fn upsert(&mut self, community: CommunityDoc) -> Result<(), FsaError> {
        self.engine.upsert(community.into_document())
    }

    pub fn remove(&mut self, id: &str) -> bool {
        self.engine.remove(id)
    }

    pub fn len(&self) -> usize {
        self.engine.len()
    }

    pub fn is_empty(&self) -> bool {
        self.engine.is_empty()
    }

    pub fn compact(&mut self) {
        self.engine.compact();
    }

    pub fn engine(&self) -> &SearchEngine {
        &self.engine
    }

    pub fn search(
        &self,
        query: &CommunitiesQuery,
        context: Option<&PersonalizationContext>,
    ) -> SearchResponse {
        let mut filters = SearchFilters::new();
        if let Some(topic_id) = &query.topic_id {
            filters = filters.require(ATTR_TOPIC, topic_id.clone());
        }
        if let Some(lang) = &query.lang {
            filters = filters.require(ATTR_LANG, lang.clone());
        }
        if query.exclude_private {
            filters = filters.exclude(ATTR_PRIVATE, "true");
        }
        let request = SearchRequest::new(query.query.clone(), query.now)
            .limit(query.limit)
            .offset(query.offset)
            .personalization(query.personalization)
            .filters(filters);
        self.engine.search(&request, context)
    }
}

impl Default for CommunitiesSearch {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fsa_contracts::{AffinityEntry, AffinitySnapshot};

    fn community(id: &str, name: &str, size_rank: f64) -> CommunityDoc {
        CommunityDoc {
            id: id.into(),
            name: name.into(),
            description: None,
            tags: Vec::new(),
            topic_id: Some("topic-music".into()),
            lang: Some("ru".into()),
            is_private: false,
            last_activity_at: 0,
            size_rank,
        }
    }

    #[test]
    fn profile_is_valid() {
        profile().validate().expect("FSA-C profile");
    }

    #[test]
    fn size_prior_and_topic_affinity() {
        let mut search = CommunitiesSearch::new();
        search
            .upsert(community("small", "Клуб гитаристов", 0.1))
            .expect("upsert");
        search
            .upsert(community("big", "Клуб гитаристов", 0.9))
            .expect("upsert");
        let response = search.search(&CommunitiesQuery::new("гитаристов", 100), None);
        assert_eq!(
            response.hits[0].id, "big",
            "размерный приор решает при равном тексте"
        );

        // Аффинити к теме поднимает маленькое сообщество при α = 1.
        let mut small_music = community("small", "Клуб гитаристов", 0.1);
        small_music.topic_id = Some("topic-rock".into());
        search.upsert(small_music).expect("upsert");
        let context = PersonalizationContext::from_snapshot(&AffinitySnapshot {
            entries: vec![AffinityEntry {
                key: affinity_key::topic("topic-rock"),
                weight: 1.0,
            }],
            generated_at: None,
        });
        let mut query = CommunitiesQuery::new("гитаристов", 100);
        query.personalization = PersonalizationLevel::MAX;
        let personalized = search.search(&query, Some(&context));
        assert_eq!(personalized.hits[0].id, "small");
    }

    #[test]
    fn private_filter_and_topic_scope() {
        let mut search = CommunitiesSearch::new();
        let mut private = community("p", "Тайный клуб", 0.5);
        private.is_private = true;
        search.upsert(private).expect("upsert");
        search
            .upsert(community("o", "Открытый клуб", 0.5))
            .expect("upsert");

        let mut query = CommunitiesQuery::new("клуб", 100);
        query.exclude_private = true;
        let response = search.search(&query, None);
        assert_eq!(response.hits.len(), 1);
        assert_eq!(response.hits[0].id, "o");

        let mut query = CommunitiesQuery::new("клуб", 100);
        query.topic_id = Some("нет-такой".into());
        let response = search.search(&query, None);
        assert_eq!(response.matched_total, 0);
    }
}
