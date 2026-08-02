//! FSA-M — поиск по сообщениям. Спека: `Documents/fsa/FSA-M.md`.
//!
//! Приватность: сообщения E2E-зашифрованы (FSCP), сервер не видит plaintext —
//! индекс FSA-M живёт **на клиенте** поверх расшифрованного локального стора
//! (ядро wasm32-совместимо и не делает I/O). Контекст аффинити строится
//! также на клиенте (частота переписки); FIRA-сигналы сервера не участвуют.

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
pub const FIELD_ATTACHMENT_NAME: &str = "attachment_name";
pub const FIELD_SENDER_NAME: &str = "sender_name";

pub const ATTR_CONVERSATION_ID: &str = "conversation_id";
pub const ATTR_SENDER_ID: &str = "sender_id";
pub const ATTR_KIND: &str = "kind";

/// Нормативный профиль FSA-M (FSA-M.md §Профиль).
pub fn profile() -> SearchProfile {
    SearchProfile {
        domain: SearchDomain::Messages,
        fields: vec![
            FieldSpec::new(FIELD_TEXT, 1.0).positions(),
            FieldSpec::new(FIELD_ATTACHMENT_NAME, 0.8),
            FieldSpec::new(FIELD_SENDER_NAME, 0.5),
        ],
        ranking: RankingParams {
            k1: 1.2,
            recency: RecencyMode::Boost {
                half_life_secs: 30 * 24 * 3600,
                weight: 0.3,
            },
            static_rank_weight: 0.0,
            proximity_weight: 0.3,
        },
        expansion: ExpansionPolicy {
            prefix_min_chars: 3,
            fuzzy_min_chars: 5,
            ..ExpansionPolicy::default()
        },
        personalization: PersonalizationPolicy { lambda: 0.3 },
        limits: EngineLimits::default(),
    }
}

/// Сообщение — вход индексации FSA-M (уже расшифрованное, на клиенте).
#[derive(Debug, Clone, PartialEq)]
pub struct MessageDoc {
    pub id: String,
    pub text: String,
    pub attachment_name: Option<String>,
    pub sender_id: String,
    pub sender_name: String,
    pub conversation_id: String,
    /// text / image / file / voice / video — словарь за модулем Messaging.
    pub kind: Option<String>,
    /// Unix-секунды отправки.
    pub sent_at: i64,
}

impl MessageDoc {
    fn into_document(self) -> Document {
        let mut doc = Document::new(self.id)
            .timestamp(self.sent_at)
            .field(FIELD_TEXT, self.text)
            .field(FIELD_SENDER_NAME, self.sender_name)
            .attr(ATTR_CONVERSATION_ID, self.conversation_id.clone())
            .attr(ATTR_SENDER_ID, self.sender_id.clone())
            .personal_key(affinity_key::sender(&self.sender_id))
            .personal_key(affinity_key::conversation(&self.conversation_id));
        if let Some(name) = self.attachment_name {
            doc = doc.field(FIELD_ATTACHMENT_NAME, name);
        }
        if let Some(kind) = self.kind {
            doc = doc.attr(ATTR_KIND, kind);
        }
        doc
    }
}

/// Параметры поиска FSA-M.
#[derive(Debug, Clone, PartialEq)]
pub struct MessagesQuery {
    pub query: String,
    pub limit: usize,
    pub offset: usize,
    pub now: i64,
    pub personalization: PersonalizationLevel,
    /// Скоуп диалогов: пусто — все диалоги индекса, иначе только указанные.
    pub conversation_ids: Vec<String>,
    pub sender_id: Option<String>,
    pub kind: Option<String>,
}

impl MessagesQuery {
    pub fn new(query: impl Into<String>, now: i64) -> Self {
        Self {
            query: query.into(),
            limit: 20,
            offset: 0,
            now,
            personalization: PersonalizationLevel::OFF,
            conversation_ids: Vec::new(),
            sender_id: None,
            kind: None,
        }
    }
}

/// Поисковый движок FSA-M (клиентский).
pub struct MessagesSearch {
    engine: SearchEngine,
}

impl MessagesSearch {
    pub fn new() -> Self {
        Self {
            engine: SearchEngine::new(profile()).expect("FSA-M profile is valid"),
        }
    }

    pub fn upsert(&mut self, message: MessageDoc) -> Result<(), FsaError> {
        self.engine.upsert(message.into_document())
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
        query: &MessagesQuery,
        context: Option<&PersonalizationContext>,
    ) -> SearchResponse {
        let mut filters = SearchFilters::new();
        if !query.conversation_ids.is_empty() {
            filters = filters.require_any(
                query
                    .conversation_ids
                    .iter()
                    .map(|id| (ATTR_CONVERSATION_ID.to_string(), id.clone()))
                    .collect(),
            );
        }
        if let Some(sender_id) = &query.sender_id {
            filters = filters.require(ATTR_SENDER_ID, sender_id.clone());
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

impl Default for MessagesSearch {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str, text: &str, conversation: &str, sent_at: i64) -> MessageDoc {
        MessageDoc {
            id: id.into(),
            text: text.into(),
            attachment_name: None,
            sender_id: "u1".into(),
            sender_name: "Иван".into(),
            conversation_id: conversation.into(),
            kind: Some("text".into()),
            sent_at,
        }
    }

    #[test]
    fn profile_is_valid() {
        profile().validate().expect("FSA-M profile");
    }

    #[test]
    fn conversation_scope_limits_results() {
        let mut search = MessagesSearch::new();
        search
            .upsert(message("m1", "встречаемся завтра", "conv-a", 100))
            .expect("upsert");
        search
            .upsert(message("m2", "встречаемся сегодня", "conv-b", 100))
            .expect("upsert");

        let all = search.search(&MessagesQuery::new("встречаемся", 200), None);
        assert_eq!(all.matched_total, 2);

        let mut scoped = MessagesQuery::new("встречаемся", 200);
        scoped.conversation_ids = vec!["conv-a".into()];
        let response = search.search(&scoped, None);
        assert_eq!(response.matched_total, 1);
        assert_eq!(response.hits[0].id, "m1");
    }

    #[test]
    fn fresh_messages_rank_higher_on_equal_text() {
        let mut search = MessagesSearch::new();
        search
            .upsert(message("old", "отчёт по проекту", "c", 0))
            .expect("upsert");
        search
            .upsert(message("new", "отчёт по проекту", "c", 2_000_000))
            .expect("upsert");
        let response = search.search(&MessagesQuery::new("отчёт", 2_000_000), None);
        assert_eq!(response.hits[0].id, "new");
    }

    #[test]
    fn attachment_names_are_searchable() {
        let mut search = MessagesSearch::new();
        let mut doc = message("m1", "держи файл", "c", 100);
        doc.attachment_name = Some("квартальный_отчёт.pdf".into());
        search.upsert(doc).expect("upsert");
        let response = search.search(&MessagesQuery::new("квартальный", 200), None);
        assert_eq!(response.matched_total, 1);
    }
}
