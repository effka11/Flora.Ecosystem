//! FSA-P — поиск людей. Спека: `Documents/fsa/FSA-P.md`.
//! Владелец данных — Social Users. Домен typeahead-ориентирован: префикс
//! с первого символа, сильный exact-boost username/имени.

use fsa_contracts::{PersonalizationLevel, SearchDomain, affinity_key};

use crate::document::Document;
use crate::engine::{SearchEngine, SearchFilters, SearchRequest, SearchResponse};
use crate::error::FsaError;
use crate::personalization::PersonalizationContext;
use crate::profile::{
    EngineLimits, ExpansionPolicy, FieldSpec, PersonalizationPolicy, RankingParams, RecencyMode,
    SearchProfile,
};

pub const FIELD_DISPLAY_NAME: &str = "display_name";
pub const FIELD_USERNAME: &str = "username";
pub const FIELD_BIO: &str = "bio";
pub const FIELD_INTERESTS: &str = "interests";
pub const FIELD_CITY: &str = "city";

pub const ATTR_VERIFIED: &str = "verified";

/// Нормативный профиль FSA-P (FSA-P.md §Профиль).
pub fn profile() -> SearchProfile {
    SearchProfile {
        domain: SearchDomain::People,
        fields: vec![
            FieldSpec::new(FIELD_DISPLAY_NAME, 2.2)
                .positions()
                .exact_boost(0.8),
            FieldSpec::new(FIELD_USERNAME, 2.0).exact_boost(1.5),
            FieldSpec::new(FIELD_BIO, 0.6),
            FieldSpec::new(FIELD_INTERESTS, 1.0),
            FieldSpec::new(FIELD_CITY, 0.5),
        ],
        ranking: RankingParams {
            k1: 1.2,
            recency: RecencyMode::Boost {
                half_life_secs: 30 * 24 * 3600,
                weight: 0.1,
            },
            static_rank_weight: 0.6,
            proximity_weight: 0.1,
        },
        expansion: ExpansionPolicy {
            prefix_min_chars: 1,
            fuzzy_min_chars: 3,
            ..ExpansionPolicy::default()
        },
        personalization: PersonalizationPolicy { lambda: 0.6 },
        limits: EngineLimits::default(),
    }
}

/// Профиль пользователя — вход индексации FSA-P.
#[derive(Debug, Clone, PartialEq)]
pub struct PersonDoc {
    pub id: String,
    pub display_name: String,
    pub username: String,
    pub bio: Option<String>,
    /// Явные интересы (человекочитаемые названия тем).
    pub interests: Vec<String>,
    /// Идентификаторы тем таксономии FIRA (для аффинити `topic:{id}`).
    pub topic_ids: Vec<String>,
    /// Сообщества пользователя (для аффинити `community:{id}`).
    pub community_ids: Vec<String>,
    pub city: Option<String>,
    pub verified: bool,
    /// Unix-секунды последней активности.
    pub last_active_at: i64,
    /// Нормированное качество профиля `[0, 1]` (заполненность, верификация).
    pub profile_rank: f64,
}

impl PersonDoc {
    fn into_document(self) -> Document {
        let mut doc = Document::new(self.id.clone())
            .timestamp(self.last_active_at)
            .static_rank(self.profile_rank)
            .field(FIELD_DISPLAY_NAME, self.display_name)
            .field(FIELD_USERNAME, self.username)
            .attr(ATTR_VERIFIED, bool_attr(self.verified))
            .personal_key(affinity_key::user(&self.id));
        if let Some(bio) = self.bio {
            doc = doc.field(FIELD_BIO, bio);
        }
        for interest in self.interests {
            doc = doc.field(FIELD_INTERESTS, interest);
        }
        for topic_id in self.topic_ids {
            doc = doc.personal_key(affinity_key::topic(&topic_id));
        }
        for community_id in self.community_ids {
            doc = doc.personal_key(affinity_key::community(&community_id));
        }
        if let Some(city) = self.city {
            doc = doc.field(FIELD_CITY, city);
        }
        doc
    }
}

fn bool_attr(value: bool) -> &'static str {
    if value { "true" } else { "false" }
}

/// Параметры поиска FSA-P.
#[derive(Debug, Clone, PartialEq)]
pub struct PeopleQuery {
    pub query: String,
    pub limit: usize,
    pub offset: usize,
    pub now: i64,
    pub personalization: PersonalizationLevel,
    pub verified_only: bool,
}

impl PeopleQuery {
    pub fn new(query: impl Into<String>, now: i64) -> Self {
        Self {
            query: query.into(),
            limit: 20,
            offset: 0,
            now,
            personalization: PersonalizationLevel::OFF,
            verified_only: false,
        }
    }
}

/// Поисковый движок FSA-P.
pub struct PeopleSearch {
    engine: SearchEngine,
}

impl PeopleSearch {
    pub fn new() -> Self {
        Self {
            engine: SearchEngine::new(profile()).expect("FSA-P profile is valid"),
        }
    }

    pub fn upsert(&mut self, person: PersonDoc) -> Result<(), FsaError> {
        self.engine.upsert(person.into_document())
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
        query: &PeopleQuery,
        context: Option<&PersonalizationContext>,
    ) -> SearchResponse {
        let mut filters = SearchFilters::new();
        if query.verified_only {
            filters = filters.require(ATTR_VERIFIED, "true");
        }
        let request = SearchRequest::new(query.query.clone(), query.now)
            .limit(query.limit)
            .offset(query.offset)
            .personalization(query.personalization)
            .filters(filters);
        self.engine.search(&request, context)
    }
}

impl Default for PeopleSearch {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fsa_contracts::{AffinityEntry, AffinitySnapshot};

    fn person(id: &str, display_name: &str, username: &str) -> PersonDoc {
        PersonDoc {
            id: id.into(),
            display_name: display_name.into(),
            username: username.into(),
            bio: None,
            interests: Vec::new(),
            topic_ids: Vec::new(),
            community_ids: Vec::new(),
            city: None,
            verified: false,
            last_active_at: 0,
            profile_rank: 0.0,
        }
    }

    #[test]
    fn profile_is_valid() {
        profile().validate().expect("FSA-P profile");
    }

    #[test]
    fn typeahead_prefix_from_first_char() {
        let mut search = PeopleSearch::new();
        search
            .upsert(person("u1", "Анна Петрова", "anna"))
            .expect("upsert");
        search
            .upsert(person("u2", "Борис Иванов", "boris"))
            .expect("upsert");
        let response = search.search(&PeopleQuery::new("ан", 100), None);
        assert_eq!(response.matched_total, 1);
        assert_eq!(response.hits[0].id, "u1");
    }

    #[test]
    fn exact_username_outranks_partial_matches() {
        let mut search = PeopleSearch::new();
        search
            .upsert(person("partial", "Anna Maria", "annamaria"))
            .expect("upsert");
        search
            .upsert(person("exact", "Кто-то", "anna"))
            .expect("upsert");
        search
            .upsert(person("named", "Anna", "someone"))
            .expect("upsert");
        let response = search.search(&PeopleQuery::new("anna", 100), None);
        assert_eq!(
            response.hits[0].id, "exact",
            "точный username — сильнейший сигнал"
        );
    }

    #[test]
    fn shared_community_affinity_reorders() {
        let mut search = PeopleSearch::new();
        let mut a = person("a", "Один Человек", "one");
        a.community_ids = vec!["c-far".into()];
        let mut b = person("b", "Один Человек", "two");
        b.community_ids = vec!["c-shared".into()];
        search.upsert(a).expect("upsert");
        search.upsert(b).expect("upsert");

        let neutral = search.search(&PeopleQuery::new("человек", 100), None);
        assert_eq!(neutral.hits[0].id, "a");

        let context = PersonalizationContext::from_snapshot(&AffinitySnapshot {
            entries: vec![AffinityEntry {
                key: affinity_key::community("c-shared"),
                weight: 0.9,
            }],
            generated_at: None,
        });
        let mut query = PeopleQuery::new("человек", 100);
        query.personalization = PersonalizationLevel::MAX;
        let personalized = search.search(&query, Some(&context));
        assert_eq!(personalized.hits[0].id, "b");
    }
}
