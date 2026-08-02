//! FSA-F — поиск по ленте (посты). Спека: `Documents/fsa/FSA-F.md`.
//! Модуль только направляет ядро: нормативный профиль + типизированное API.
//! Владелец данных — Social Content; он поставляет документы и фильтрует
//! видимость (приватные сообщества, блокировки) **до** индексации.

use fsa_contracts::{PersonalizationLevel, SearchDomain, affinity_key};

use crate::document::Document;
use crate::engine::{SearchEngine, SearchFilters, SearchRequest, SearchResponse};
use crate::error::FsaError;
use crate::personalization::PersonalizationContext;
use crate::profile::{
    EngineLimits, ExpansionPolicy, FieldSpec, PersonalizationPolicy, RankingParams, RecencyMode,
    SearchProfile,
};

pub const FIELD_TEXT: &str = "text";
pub const FIELD_TAGS: &str = "tags";
pub const FIELD_AUTHOR_NAME: &str = "author_name";
pub const FIELD_COMMUNITY_NAME: &str = "community_name";

pub const ATTR_AUTHOR_ID: &str = "author_id";
pub const ATTR_COMMUNITY_ID: &str = "community_id";
pub const ATTR_LANG: &str = "lang";
pub const ATTR_KIND: &str = "kind";

pub const KIND_POST: &str = "post";
pub const KIND_REPOST: &str = "repost";

/// Нормативный профиль FSA-F (FSA-F.md §Профиль).
pub fn profile() -> SearchProfile {
    SearchProfile {
        domain: SearchDomain::Feed,
        fields: vec![
            FieldSpec::new(FIELD_TEXT, 1.0).positions(),
            FieldSpec::new(FIELD_TAGS, 1.6),
            FieldSpec::new(FIELD_AUTHOR_NAME, 0.7),
            FieldSpec::new(FIELD_COMMUNITY_NAME, 0.5),
        ],
        ranking: RankingParams {
            k1: 1.2,
            recency: RecencyMode::Boost {
                half_life_secs: 48 * 3600,
                weight: 0.35,
            },
            static_rank_weight: 0.4,
            proximity_weight: 0.25,
        },
        expansion: ExpansionPolicy {
            prefix_min_chars: 3,
            fuzzy_min_chars: 4,
            ..ExpansionPolicy::default()
        },
        personalization: PersonalizationPolicy { lambda: 1.0 },
        limits: EngineLimits::default(),
    }
}

/// Пост ленты — вход индексации FSA-F.
#[derive(Debug, Clone, PartialEq)]
pub struct FeedPost {
    pub id: String,
    pub text: String,
    pub tags: Vec<String>,
    pub author_id: String,
    pub author_name: String,
    pub community_id: Option<String>,
    pub community_name: Option<String>,
    pub lang: Option<String>,
    pub is_repost: bool,
    /// Unix-секунды публикации.
    pub created_at: i64,
    /// Нормированный engagement-приор `[0, 1]` (глобальный, не персональный).
    pub engagement_rank: f64,
}

impl FeedPost {
    fn into_document(self) -> Document {
        let mut doc = Document::new(self.id)
            .timestamp(self.created_at)
            .static_rank(self.engagement_rank)
            .field(FIELD_TEXT, self.text)
            .field(FIELD_AUTHOR_NAME, self.author_name)
            .attr(ATTR_AUTHOR_ID, self.author_id.clone())
            .attr(
                ATTR_KIND,
                if self.is_repost {
                    KIND_REPOST
                } else {
                    KIND_POST
                },
            )
            .personal_key(affinity_key::author(&self.author_id));
        for tag in self.tags {
            doc = doc
                .field(FIELD_TAGS, tag.clone())
                .personal_key(affinity_key::tag(&tag));
        }
        if let Some(community_id) = self.community_id {
            doc = doc
                .attr(ATTR_COMMUNITY_ID, community_id.clone())
                .personal_key(affinity_key::community(&community_id));
        }
        if let Some(community_name) = self.community_name {
            doc = doc.field(FIELD_COMMUNITY_NAME, community_name);
        }
        if let Some(lang) = self.lang {
            doc = doc.attr(ATTR_LANG, lang);
        }
        doc
    }
}

/// Параметры поиска FSA-F.
#[derive(Debug, Clone, PartialEq)]
pub struct FeedQuery {
    pub query: String,
    pub limit: usize,
    pub offset: usize,
    /// Unix-секунды «сейчас» (инъекция времени — детерминизм).
    pub now: i64,
    /// Уровень индивидуальности α; действует вместе с контекстом аффинити.
    pub personalization: PersonalizationLevel,
    pub author_id: Option<String>,
    pub community_id: Option<String>,
    pub lang: Option<String>,
    /// `false` — исключить репосты из выдачи.
    pub include_reposts: bool,
}

impl FeedQuery {
    pub fn new(query: impl Into<String>, now: i64) -> Self {
        Self {
            query: query.into(),
            limit: 20,
            offset: 0,
            now,
            personalization: PersonalizationLevel::OFF,
            author_id: None,
            community_id: None,
            lang: None,
            include_reposts: true,
        }
    }
}

/// Поисковый движок FSA-F.
pub struct FeedSearch {
    engine: SearchEngine,
}

impl FeedSearch {
    pub fn new() -> Self {
        Self {
            engine: SearchEngine::new(profile()).expect("FSA-F profile is valid"),
        }
    }

    pub fn upsert(&mut self, post: FeedPost) -> Result<(), FsaError> {
        self.engine.upsert(post.into_document())
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
        query: &FeedQuery,
        context: Option<&PersonalizationContext>,
    ) -> SearchResponse {
        let mut filters = SearchFilters::new();
        if let Some(author_id) = &query.author_id {
            filters = filters.require(ATTR_AUTHOR_ID, author_id.clone());
        }
        if let Some(community_id) = &query.community_id {
            filters = filters.require(ATTR_COMMUNITY_ID, community_id.clone());
        }
        if let Some(lang) = &query.lang {
            filters = filters.require(ATTR_LANG, lang.clone());
        }
        if !query.include_reposts {
            filters = filters.exclude(ATTR_KIND, KIND_REPOST);
        }
        let request = SearchRequest::new(query.query.clone(), query.now)
            .limit(query.limit)
            .offset(query.offset)
            .personalization(query.personalization)
            .filters(filters);
        self.engine.search(&request, context)
    }
}

impl Default for FeedSearch {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fsa_contracts::{AffinityEntry, AffinitySnapshot};

    fn post(id: &str, text: &str, author: &str, created_at: i64) -> FeedPost {
        FeedPost {
            id: id.into(),
            text: text.into(),
            tags: vec!["rust".into()],
            author_id: author.into(),
            author_name: format!("Автор {author}"),
            community_id: None,
            community_name: None,
            lang: Some("ru".into()),
            is_repost: false,
            created_at,
            engagement_rank: 0.0,
        }
    }

    #[test]
    fn profile_is_valid() {
        profile().validate().expect("FSA-F profile");
    }

    #[test]
    fn indexes_and_finds_posts() {
        let mut search = FeedSearch::new();
        search
            .upsert(post("p1", "Изучаем поиск в Rust", "u1", 100))
            .expect("upsert");
        search
            .upsert(post("p2", "Совсем другое", "u2", 100))
            .expect("upsert");
        let response = search.search(&FeedQuery::new("поиск", 200), None);
        assert_eq!(response.matched_total, 1);
        assert_eq!(response.hits[0].id, "p1");
    }

    #[test]
    fn personalization_reorders_equal_posts() {
        let mut search = FeedSearch::new();
        search
            .upsert(post("a", "текст поста", "author-a", 100))
            .expect("upsert");
        search
            .upsert(post("b", "текст поста", "author-b", 100))
            .expect("upsert");

        let neutral = search.search(&FeedQuery::new("текст", 200), None);
        assert_eq!(neutral.hits[0].id, "a", "tie-break id asc без α");

        let context = PersonalizationContext::from_snapshot(&AffinitySnapshot {
            entries: vec![AffinityEntry {
                key: affinity_key::author("author-b"),
                weight: 1.0,
            }],
            generated_at: None,
        });
        let mut query = FeedQuery::new("текст", 200);
        query.personalization = PersonalizationLevel::MAX;
        let personalized = search.search(&query, Some(&context));
        assert_eq!(
            personalized.hits[0].id, "b",
            "аффинити к автору поднимает пост"
        );
        assert_eq!(
            personalized.matched_total, neutral.matched_total,
            "персонализация не меняет состав выдачи"
        );
    }

    #[test]
    fn filters_exclude_reposts_and_scope_by_author() {
        let mut search = FeedSearch::new();
        let mut repost = post("r1", "общий текст", "u1", 100);
        repost.is_repost = true;
        search.upsert(repost).expect("upsert");
        search
            .upsert(post("p1", "общий текст", "u2", 100))
            .expect("upsert");

        let mut query = FeedQuery::new("общий", 200);
        query.include_reposts = false;
        let response = search.search(&query, None);
        assert_eq!(response.hits.len(), 1);
        assert_eq!(response.hits[0].id, "p1");

        let mut query = FeedQuery::new("общий", 200);
        query.author_id = Some("u1".into());
        let response = search.search(&query, None);
        assert_eq!(response.hits[0].id, "r1");
    }
}
