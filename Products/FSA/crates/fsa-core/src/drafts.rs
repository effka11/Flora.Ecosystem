//! FSA-D — поиск по черновикам. Спека: `Documents/fsa/FSA-D.md`.
//!
//! Черновики — личные данные: персонализация принципиально нейтральна
//! (`λ_d = 0`, любой α даёт множитель ровно 1) — индивидуальность здесь
//! бессмысленна, а сигналы FIRA не должны касаться приватного контента.
//! Индекс может жить и на клиенте (wasm32), и в модуле-владельце.

use fsa_contracts::SearchDomain;

use crate::document::Document;
use crate::engine::{SearchEngine, SearchFilters, SearchRequest, SearchResponse};
use crate::error::FsaError;
use crate::profile::{
    EngineLimits, ExpansionPolicy, FieldSpec, PersonalizationPolicy, RankingParams, RecencyMode,
    SearchProfile,
};

pub const FIELD_TITLE: &str = "title";
pub const FIELD_TEXT: &str = "text";
pub const FIELD_TAGS: &str = "tags";

pub const ATTR_KIND: &str = "kind";
pub const ATTR_COMMUNITY_ID: &str = "community_id";

/// Нормативный профиль FSA-D (FSA-D.md §Профиль).
pub fn profile() -> SearchProfile {
    SearchProfile {
        domain: SearchDomain::Drafts,
        fields: vec![
            FieldSpec::new(FIELD_TITLE, 1.8).positions(),
            FieldSpec::new(FIELD_TEXT, 1.0).positions(),
            FieldSpec::new(FIELD_TAGS, 1.2),
        ],
        ranking: RankingParams {
            k1: 1.2,
            recency: RecencyMode::Boost {
                half_life_secs: 14 * 24 * 3600,
                weight: 0.5,
            },
            static_rank_weight: 0.0,
            proximity_weight: 0.2,
        },
        expansion: ExpansionPolicy {
            prefix_min_chars: 1,
            fuzzy_min_chars: 3,
            ..ExpansionPolicy::default()
        },
        // Нормативно: черновики неперсонализируемы (FSA-D.md §Персонализация).
        personalization: PersonalizationPolicy { lambda: 0.0 },
        limits: EngineLimits::default(),
    }
}

/// Черновик — вход индексации FSA-D.
#[derive(Debug, Clone, PartialEq)]
pub struct DraftDoc {
    pub id: String,
    pub title: Option<String>,
    pub text: String,
    pub tags: Vec<String>,
    /// post / article — словарь за модулем-владельцем.
    pub kind: Option<String>,
    /// Черновик для сообщества (если есть).
    pub community_id: Option<String>,
    /// Unix-секунды последнего редактирования.
    pub updated_at: i64,
}

impl DraftDoc {
    fn into_document(self) -> Document {
        let mut doc = Document::new(self.id)
            .timestamp(self.updated_at)
            .field(FIELD_TEXT, self.text);
        if let Some(title) = self.title {
            doc = doc.field(FIELD_TITLE, title);
        }
        for tag in self.tags {
            doc = doc.field(FIELD_TAGS, tag);
        }
        if let Some(kind) = self.kind {
            doc = doc.attr(ATTR_KIND, kind);
        }
        if let Some(community_id) = self.community_id {
            doc = doc.attr(ATTR_COMMUNITY_ID, community_id);
        }
        doc
    }
}

/// Параметры поиска FSA-D. Поля персонализации нет намеренно:
/// профиль нормативно неперсонализируем.
#[derive(Debug, Clone, PartialEq)]
pub struct DraftsQuery {
    pub query: String,
    pub limit: usize,
    pub offset: usize,
    pub now: i64,
    pub kind: Option<String>,
    pub community_id: Option<String>,
}

impl DraftsQuery {
    pub fn new(query: impl Into<String>, now: i64) -> Self {
        Self {
            query: query.into(),
            limit: 20,
            offset: 0,
            now,
            kind: None,
            community_id: None,
        }
    }
}

/// Поисковый движок FSA-D.
pub struct DraftsSearch {
    engine: SearchEngine,
}

impl DraftsSearch {
    pub fn new() -> Self {
        Self {
            engine: SearchEngine::new(profile()).expect("FSA-D profile is valid"),
        }
    }

    pub fn upsert(&mut self, draft: DraftDoc) -> Result<(), FsaError> {
        self.engine.upsert(draft.into_document())
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

    pub fn search(&self, query: &DraftsQuery) -> SearchResponse {
        let mut filters = SearchFilters::new();
        if let Some(kind) = &query.kind {
            filters = filters.require(ATTR_KIND, kind.clone());
        }
        if let Some(community_id) = &query.community_id {
            filters = filters.require(ATTR_COMMUNITY_ID, community_id.clone());
        }
        let request = SearchRequest::new(query.query.clone(), query.now)
            .limit(query.limit)
            .offset(query.offset)
            .filters(filters);
        self.engine.search(&request, None)
    }
}

impl Default for DraftsSearch {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::personalization::blend_multiplier;

    fn draft(id: &str, title: &str, text: &str, updated_at: i64) -> DraftDoc {
        DraftDoc {
            id: id.into(),
            title: Some(title.into()),
            text: text.into(),
            tags: Vec::new(),
            kind: Some("post".into()),
            community_id: None,
            updated_at,
        }
    }

    #[test]
    fn profile_is_valid_and_non_personalizable() {
        let p = profile();
        p.validate().expect("FSA-D profile");
        assert_eq!(p.personalization.lambda, 0.0);
        // λ = 0 нейтрализует любой α.
        assert_eq!(blend_multiplier(1.0, p.personalization.lambda, 1.0), 1.0);
    }

    #[test]
    fn recently_edited_drafts_first() {
        let mut search = DraftsSearch::new();
        search
            .upsert(draft("old", "план статьи", "текст", 0))
            .expect("upsert");
        search
            .upsert(draft("new", "план статьи", "текст", 1_000_000))
            .expect("upsert");
        let response = search.search(&DraftsQuery::new("план", 1_000_000));
        assert_eq!(response.hits[0].id, "new");
    }

    #[test]
    fn single_char_prefix_typeahead() {
        let mut search = DraftsSearch::new();
        search
            .upsert(draft("d1", "Идея", "про поиск", 100))
            .expect("upsert");
        let response = search.search(&DraftsQuery::new("и", 200));
        assert_eq!(response.matched_total, 1);
    }

    #[test]
    fn community_scope_filter() {
        let mut search = DraftsSearch::new();
        let mut community_draft = draft("c1", "анонс", "текст", 100);
        community_draft.community_id = Some("comm-1".into());
        search.upsert(community_draft).expect("upsert");
        search
            .upsert(draft("p1", "анонс", "текст", 100))
            .expect("upsert");

        let mut query = DraftsQuery::new("анонс", 200);
        query.community_id = Some("comm-1".into());
        let response = search.search(&query);
        assert_eq!(response.hits.len(), 1);
        assert_eq!(response.hits[0].id, "c1");
    }
}
