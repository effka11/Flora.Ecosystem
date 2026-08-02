//! FSA-N — поиск по уведомлениям. Спека: `Documents/fsa/FSA-N.md`.
//! Владелец данных — Social Notifications. Домен recency-first: свежесть
//! первична (`RecencyMode::Primary`), текстовый скоринг — фильтр и tie-break.

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
pub const FIELD_ACTOR_NAME: &str = "actor_name";

pub const ATTR_KIND: &str = "kind";
pub const ATTR_READ: &str = "read";
pub const ATTR_ACTOR_ID: &str = "actor_id";

/// Нормативный профиль FSA-N (FSA-N.md §Профиль).
pub fn profile() -> SearchProfile {
    SearchProfile {
        domain: SearchDomain::Notifications,
        fields: vec![
            FieldSpec::new(FIELD_TEXT, 1.0).positions(),
            FieldSpec::new(FIELD_ACTOR_NAME, 1.2),
        ],
        ranking: RankingParams {
            k1: 1.2,
            recency: RecencyMode::Primary,
            static_rank_weight: 0.0,
            proximity_weight: 0.0,
        },
        expansion: ExpansionPolicy {
            prefix_min_chars: 3,
            fuzzy_min_chars: 5,
            ..ExpansionPolicy::default()
        },
        personalization: PersonalizationPolicy { lambda: 0.4 },
        limits: EngineLimits::default(),
    }
}

/// Уведомление — вход индексации FSA-N.
#[derive(Debug, Clone, PartialEq)]
pub struct NotificationDoc {
    pub id: String,
    pub text: String,
    pub actor_id: Option<String>,
    pub actor_name: Option<String>,
    /// like / comment / follow / mention / system — словарь за Notifications.
    pub kind: Option<String>,
    pub read: bool,
    /// Unix-секунды создания.
    pub created_at: i64,
}

impl NotificationDoc {
    fn into_document(self) -> Document {
        let mut doc = Document::new(self.id)
            .timestamp(self.created_at)
            .field(FIELD_TEXT, self.text)
            .attr(ATTR_READ, bool_attr(self.read));
        if let Some(actor_id) = self.actor_id {
            doc = doc
                .attr(ATTR_ACTOR_ID, actor_id.clone())
                .personal_key(affinity_key::actor(&actor_id));
        }
        if let Some(actor_name) = self.actor_name {
            doc = doc.field(FIELD_ACTOR_NAME, actor_name);
        }
        if let Some(kind) = self.kind {
            doc = doc.attr(ATTR_KIND, kind);
        }
        doc
    }
}

fn bool_attr(value: bool) -> &'static str {
    if value { "true" } else { "false" }
}

/// Параметры поиска FSA-N.
#[derive(Debug, Clone, PartialEq)]
pub struct NotificationsQuery {
    pub query: String,
    pub limit: usize,
    pub offset: usize,
    pub now: i64,
    pub personalization: PersonalizationLevel,
    pub unread_only: bool,
    pub kind: Option<String>,
}

impl NotificationsQuery {
    pub fn new(query: impl Into<String>, now: i64) -> Self {
        Self {
            query: query.into(),
            limit: 20,
            offset: 0,
            now,
            personalization: PersonalizationLevel::OFF,
            unread_only: false,
            kind: None,
        }
    }
}

/// Поисковый движок FSA-N.
pub struct NotificationsSearch {
    engine: SearchEngine,
}

impl NotificationsSearch {
    pub fn new() -> Self {
        Self {
            engine: SearchEngine::new(profile()).expect("FSA-N profile is valid"),
        }
    }

    pub fn upsert(&mut self, notification: NotificationDoc) -> Result<(), FsaError> {
        self.engine.upsert(notification.into_document())
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
        query: &NotificationsQuery,
        context: Option<&PersonalizationContext>,
    ) -> SearchResponse {
        let mut filters = SearchFilters::new();
        if query.unread_only {
            filters = filters.require(ATTR_READ, "false");
        }
        if let Some(kind) = &query.kind {
            filters = filters.require(ATTR_KIND, kind.clone());
        }
        let request = SearchRequest::new(query.query.clone(), query.now)
            .limit(query.limit)
            .offset(query.offset)
            .personalization(query.personalization)
            .filters(filters);
        self.engine.search(&request, context)
    }
}

impl Default for NotificationsSearch {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notification(id: &str, text: &str, created_at: i64, read: bool) -> NotificationDoc {
        NotificationDoc {
            id: id.into(),
            text: text.into(),
            actor_id: Some("u1".into()),
            actor_name: Some("Мария".into()),
            kind: Some("like".into()),
            read,
            created_at,
        }
    }

    #[test]
    fn profile_is_valid() {
        profile().validate().expect("FSA-N profile");
    }

    #[test]
    fn recency_is_primary_regardless_of_text_score() {
        let mut search = NotificationsSearch::new();
        // Старое, но с двойным вхождением терма (выше текстовый скор).
        search
            .upsert(notification("old", "лайк лайк на ваш пост", 100, false))
            .expect("upsert");
        search
            .upsert(notification("new", "новый лайк", 200, false))
            .expect("upsert");
        let response = search.search(&NotificationsQuery::new("лайк", 300), None);
        assert_eq!(response.hits[0].id, "new", "свежесть первична");
        assert_eq!(response.hits[1].id, "old");
    }

    #[test]
    fn unread_and_kind_filters() {
        let mut search = NotificationsSearch::new();
        search
            .upsert(notification("read", "лайк на пост", 100, true))
            .expect("upsert");
        search
            .upsert(notification("unread", "лайк на фото", 200, false))
            .expect("upsert");
        let mut query = NotificationsQuery::new("лайк", 300);
        query.unread_only = true;
        let response = search.search(&query, None);
        assert_eq!(response.hits.len(), 1);
        assert_eq!(response.hits[0].id, "unread");

        let mut query = NotificationsQuery::new("лайк", 300);
        query.kind = Some("follow".into());
        let response = search.search(&query, None);
        assert_eq!(response.matched_total, 0);
    }

    #[test]
    fn actor_name_is_searchable() {
        let mut search = NotificationsSearch::new();
        search
            .upsert(notification("n1", "подписался на вас", 100, false))
            .expect("upsert");
        let response = search.search(&NotificationsQuery::new("мария", 200), None);
        assert_eq!(response.matched_total, 1);
    }
}
