//! Фасад ядра FSA: индексация документов, поиск, обслуживание индекса.
//! Владение движком (шардирование, блокировки, персистентность) — зона
//! интегрирующего модуля; ядро — чистая in-memory структура без I/O и часов
//! (`now` инъецируется запросом — детерминизм и wasm32-совместимость).

use fsa_contracts::PersonalizationLevel;

use crate::document::Document;
use crate::error::FsaError;
use crate::executor::{ExecParams, execute};
use crate::index::{PreparedDoc, SearchIndex, attr_term_key};
use crate::personalization::PersonalizationContext;
use crate::profile::SearchProfile;
use crate::query::parse;
use crate::text::{joined_terms_hash, tokenize};

/// Структурные фильтры по атрибутам (сравнение байт-в-байт; FSA.md §3.3).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SearchFilters {
    /// Документ обязан иметь каждый атрибут.
    pub all_of: Vec<(String, String)>,
    /// Для каждой группы — хотя бы один атрибут из группы (скоупы).
    pub any_of: Vec<Vec<(String, String)>>,
    /// Документ не должен иметь ни одного из атрибутов.
    pub none_of: Vec<(String, String)>,
}

impl SearchFilters {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn require(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.all_of.push((name.into(), value.into()));
        self
    }

    pub fn require_any(mut self, alternatives: Vec<(String, String)>) -> Self {
        self.any_of.push(alternatives);
        self
    }

    pub fn exclude(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.none_of.push((name.into(), value.into()));
        self
    }
}

/// Поисковый запрос. `now` (unix-секунды) обязателен — ядро не читает часы.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchRequest {
    pub query: String,
    pub limit: usize,
    pub offset: usize,
    pub now: i64,
    /// Уровень индивидуальности α (FSA.md §5). Действует только вместе с
    /// переданным [`PersonalizationContext`].
    pub personalization: PersonalizationLevel,
    pub filters: SearchFilters,
}

impl SearchRequest {
    pub fn new(query: impl Into<String>, now: i64) -> Self {
        Self {
            query: query.into(),
            limit: 20,
            offset: 0,
            now,
            personalization: PersonalizationLevel::OFF,
            filters: SearchFilters::default(),
        }
    }

    pub fn limit(mut self, limit: usize) -> Self {
        self.limit = limit;
        self
    }

    pub fn offset(mut self, offset: usize) -> Self {
        self.offset = offset;
        self
    }

    pub fn personalization(mut self, level: PersonalizationLevel) -> Self {
        self.personalization = level;
        self
    }

    pub fn filters(mut self, filters: SearchFilters) -> Self {
        self.filters = filters;
        self
    }
}

/// Найденный документ.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub id: String,
    pub score: f64,
    pub timestamp: i64,
    /// Термы индекса, обеспечившие совпадение (для подсветки на стороне UI).
    pub matched_terms: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SearchResponse {
    pub hits: Vec<Hit>,
    /// Полное число документов, удовлетворивших запросу (точное).
    pub matched_total: usize,
}

/// Поисковый движок одной поверхности (профиль + индекс).
pub struct SearchEngine {
    profile: SearchProfile,
    index: SearchIndex,
}

impl SearchEngine {
    pub fn new(profile: SearchProfile) -> Result<Self, FsaError> {
        profile.validate()?;
        let index = SearchIndex::new(profile.fields.len(), profile.fuzzy_enabled());
        Ok(Self { profile, index })
    }

    pub fn profile(&self) -> &SearchProfile {
        &self.profile
    }

    /// Живых документов в индексе.
    pub fn len(&self) -> usize {
        self.index.alive_docs() as usize
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn contains(&self, id: &str) -> bool {
        self.index.contains(id)
    }

    /// Tombstone-документов (кандидатов на `compact`).
    pub fn tombstones(&self) -> usize {
        self.index.tombstones()
    }

    /// Перестраивает индекс без tombstone-документов (FSA.md §3.4).
    pub fn compact(&mut self) {
        self.index.compact();
    }

    /// Добавляет документ или заменяет версию с тем же id.
    pub fn upsert(&mut self, doc: Document) -> Result<(), FsaError> {
        let field_count = self.profile.fields.len();
        let mut field_terms: Vec<Vec<(String, u32)>> = vec![Vec::new(); field_count];
        let mut field_len = vec![0u32; field_count];
        let mut field_hash = vec![0u64; field_count];

        for (name, text) in &doc.fields {
            let Some(field_id) = self.profile.field_id(name) else {
                return Err(FsaError::UnknownField {
                    field: name.clone(),
                });
            };
            let f = usize::from(field_id);
            let spec = &self.profile.fields[f];
            let tokens = tokenize(
                text,
                self.profile.limits.max_field_tokens,
                self.profile.limits.max_token_chars,
            );
            field_len[f] = u32::try_from(tokens.len()).unwrap_or(u32::MAX);
            if spec.exact_boost > 0.0 && !tokens.is_empty() {
                field_hash[f] = joined_terms_hash(tokens.iter().map(|t| t.term.as_str()));
            }
            field_terms[f] = tokens
                .into_iter()
                .map(|t| {
                    let position = if spec.positions { t.position } else { u32::MAX };
                    (t.term, position)
                })
                .collect();
        }

        let attr_terms = doc
            .attrs
            .iter()
            .map(|(name, value)| attr_term_key(name, value))
            .collect();
        self.index.insert(PreparedDoc {
            ext_id: doc.id,
            timestamp: doc.timestamp,
            static_rank: doc.static_rank,
            personal_keys: doc.personal_keys,
            field_terms,
            field_len,
            field_hash,
            attr_terms,
        });
        Ok(())
    }

    /// Удаляет документ (tombstone). `true`, если документ существовал.
    pub fn remove(&mut self, id: &str) -> bool {
        self.index.remove(id)
    }

    /// Поиск. Контекст персонализации опционален: без него (или при α = 0)
    /// выдача бит-в-бит неперсонализирована (FSA.md §5.3).
    pub fn search(
        &self,
        request: &SearchRequest,
        context: Option<&PersonalizationContext>,
    ) -> SearchResponse {
        let parsed = parse(
            &request.query,
            self.profile.limits.max_query_tokens,
            self.profile.limits.max_token_chars,
        );
        let window = self.profile.limits.max_results_window;
        let offset = request.offset.min(window);
        let limit = request.limit.min(window - offset);

        let outcome = execute(&ExecParams {
            profile: &self.profile,
            index: &self.index,
            parsed: &parsed,
            filters: &request.filters,
            alpha: request.personalization.value(),
            context,
            now: request.now,
            offset,
            limit,
        });

        let hits = outcome
            .hits
            .into_iter()
            .map(|scored| {
                let stored = self.index.doc(scored.doc);
                let mut matched_terms: Vec<String> = scored
                    .matched_terms
                    .iter()
                    .map(|t| self.index.term_text(*t).to_string())
                    .collect();
                matched_terms.sort_unstable();
                matched_terms.dedup();
                Hit {
                    id: stored.ext_id.clone(),
                    score: scored.score,
                    timestamp: stored.timestamp,
                    matched_terms,
                }
            })
            .collect();
        SearchResponse {
            hits,
            matched_total: outcome.matched_total,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::{
        EngineLimits, ExpansionPolicy, FieldSpec, PersonalizationPolicy, RankingParams,
        RecencyMode, SearchProfile,
    };
    use fsa_contracts::SearchDomain;

    fn profile() -> SearchProfile {
        SearchProfile {
            domain: SearchDomain::Feed,
            fields: vec![
                FieldSpec::new("title", 2.0).positions().exact_boost(0.8),
                FieldSpec::new("body", 1.0).positions(),
            ],
            ranking: RankingParams::default(),
            expansion: ExpansionPolicy::default(),
            personalization: PersonalizationPolicy { lambda: 1.0 },
            limits: EngineLimits::default(),
        }
    }

    fn engine_with(docs: &[(&str, &str, &str)]) -> SearchEngine {
        let mut engine = SearchEngine::new(profile()).expect("profile");
        for (id, title, body) in docs {
            engine
                .upsert(
                    Document::new(*id)
                        .field("title", *title)
                        .field("body", *body),
                )
                .expect("upsert");
        }
        engine
    }

    fn ids(response: &SearchResponse) -> Vec<&str> {
        response.hits.iter().map(|h| h.id.as_str()).collect()
    }

    #[test]
    fn basic_relevance_prefers_title_and_tf() {
        let engine = engine_with(&[
            ("a", "rust language", "systems programming"),
            ("b", "cooking", "rust appears in body rust rust"),
            ("c", "unrelated", "nothing here"),
        ]);
        let response = engine.search(&SearchRequest::new("rust", 0), None);
        assert_eq!(response.matched_total, 2);
        assert_eq!(ids(&response), vec!["a", "b"], "title weight beats body tf");
    }

    #[test]
    fn and_semantics_requires_all_tokens() {
        let engine = engine_with(&[
            ("a", "rust async", "tokio runtime"),
            ("b", "rust", "no second token"),
        ]);
        let response = engine.search(&SearchRequest::new("rust tokio", 0), None);
        assert_eq!(ids(&response), vec!["a"]);
    }

    #[test]
    fn negation_excludes_documents() {
        let engine = engine_with(&[
            ("a", "rust guide", "for beginners"),
            ("b", "rust guide", "for experts"),
        ]);
        let response = engine.search(&SearchRequest::new("rust -experts", 0), None);
        assert_eq!(ids(&response), vec!["a"]);
    }

    #[test]
    fn phrase_requires_adjacency() {
        let engine = engine_with(&[
            ("a", "новый альбом группы", ""),
            ("b", "альбом старый и новый взгляд", ""),
        ]);
        let response = engine.search(&SearchRequest::new("\"новый альбом\"", 0), None);
        assert_eq!(ids(&response), vec!["a"]);
    }

    #[test]
    fn prefix_expansion_on_last_token() {
        let engine = engine_with(&[("a", "programming", ""), ("b", "program", "")]);
        let response = engine.search(&SearchRequest::new("progra", 0), None);
        assert_eq!(response.matched_total, 2);
        // Точный терм короче — но оба найдены префиксом; порядок по скорингу.
        assert_eq!(response.hits.len(), 2);
    }

    #[test]
    fn fuzzy_matches_single_typo() {
        let engine = engine_with(&[("a", "metallica", "")]);
        let response = engine.search(&SearchRequest::new("metalica", 0), None);
        assert_eq!(ids(&response), vec!["a"]);
        assert_eq!(
            response.hits[0].matched_terms,
            vec!["metallica".to_string()]
        );
    }

    #[test]
    fn layout_correction_finds_wrong_keyboard() {
        let engine = engine_with(&[("a", "привет мир", "")]);
        let response = engine.search(&SearchRequest::new("ghbdtn", 0), None);
        assert_eq!(ids(&response), vec!["a"]);
    }

    #[test]
    fn exact_field_match_boosts() {
        let engine = engine_with(&[
            ("exact", "rust", ""),
            ("longer", "rust and more words in title", ""),
        ]);
        let response = engine.search(&SearchRequest::new("rust", 0), None);
        assert_eq!(ids(&response)[0], "exact");
    }

    #[test]
    fn filters_scope_results() {
        let mut engine = SearchEngine::new(profile()).expect("profile");
        for (id, kind) in [("a", "post"), ("b", "repost"), ("c", "post")] {
            engine
                .upsert(
                    Document::new(id)
                        .field("title", "rust")
                        .attr("kind", kind)
                        .attr("lang", if id == "c" { "en" } else { "ru" }),
                )
                .expect("upsert");
        }
        let response = engine.search(
            &SearchRequest::new("rust", 0).filters(SearchFilters::new().require("kind", "post")),
            None,
        );
        assert_eq!(response.matched_total, 2);
        let response = engine.search(
            &SearchRequest::new("rust", 0).filters(
                SearchFilters::new()
                    .require("kind", "post")
                    .exclude("lang", "en"),
            ),
            None,
        );
        assert_eq!(ids(&response), vec!["a"]);
        let response = engine.search(
            &SearchRequest::new("rust", 0).filters(SearchFilters::new().require_any(vec![
                ("kind".into(), "repost".into()),
                ("lang".into(), "en".into()),
            ])),
            None,
        );
        assert_eq!(response.matched_total, 2);
    }

    #[test]
    fn upsert_replaces_and_remove_hides() {
        let mut engine = engine_with(&[("a", "old title", "")]);
        engine
            .upsert(Document::new("a").field("title", "new title"))
            .expect("upsert");
        assert_eq!(engine.len(), 1);
        assert_eq!(engine.tombstones(), 1);
        let response = engine.search(&SearchRequest::new("old", 0), None);
        assert_eq!(response.matched_total, 0);
        let response = engine.search(&SearchRequest::new("new", 0), None);
        assert_eq!(response.matched_total, 1);
        assert!(engine.remove("a"));
        let response = engine.search(&SearchRequest::new("new", 0), None);
        assert_eq!(response.matched_total, 0);
        engine.compact();
        assert_eq!(engine.tombstones(), 0);
    }

    #[test]
    fn unknown_field_is_rejected() {
        let mut engine = SearchEngine::new(profile()).expect("profile");
        let err = engine
            .upsert(Document::new("x").field("nope", "text"))
            .expect_err("unknown field");
        assert_eq!(
            err,
            FsaError::UnknownField {
                field: "nope".into()
            }
        );
    }

    #[test]
    fn recency_boost_and_primary_modes() {
        let mut boost_profile = profile();
        boost_profile.ranking.recency = RecencyMode::Boost {
            half_life_secs: 3600,
            weight: 1.0,
        };
        let mut engine = SearchEngine::new(boost_profile).expect("profile");
        for (id, ts) in [("old", 0i64), ("fresh", 10_000)] {
            engine
                .upsert(Document::new(id).timestamp(ts).field("title", "rust"))
                .expect("upsert");
        }
        let response = engine.search(&SearchRequest::new("rust", 10_000), None);
        assert_eq!(ids(&response), vec!["fresh", "old"]);

        let mut primary_profile = profile();
        primary_profile.ranking.recency = RecencyMode::Primary;
        let mut engine = SearchEngine::new(primary_profile).expect("profile");
        // Более релевантный (двойной rust), но старый — против свежего.
        engine
            .upsert(
                Document::new("relevant")
                    .timestamp(100)
                    .field("title", "rust rust rust"),
            )
            .expect("upsert");
        engine
            .upsert(Document::new("fresh").timestamp(200).field("title", "rust"))
            .expect("upsert");
        let response = engine.search(&SearchRequest::new("rust", 300), None);
        assert_eq!(ids(&response), vec!["fresh", "relevant"]);
    }

    #[test]
    fn offset_pagination_is_stable() {
        let engine = engine_with(&[
            ("a", "rust", ""),
            ("b", "rust", ""),
            ("c", "rust", ""),
            ("d", "rust", ""),
        ]);
        let all = engine.search(&SearchRequest::new("rust", 0).limit(4), None);
        let page1 = engine.search(&SearchRequest::new("rust", 0).limit(2), None);
        let page2 = engine.search(&SearchRequest::new("rust", 0).limit(2).offset(2), None);
        let combined: Vec<&str> = page1
            .hits
            .iter()
            .chain(page2.hits.iter())
            .map(|h| h.id.as_str())
            .collect();
        assert_eq!(ids(&all), combined);
        // Идентичные скоры → tie-break по id asc.
        assert_eq!(ids(&all), vec!["a", "b", "c", "d"]);
    }

    #[test]
    fn empty_query_returns_empty_response() {
        let engine = engine_with(&[("a", "rust", "")]);
        let response = engine.search(&SearchRequest::new("   ", 0), None);
        assert_eq!(response, SearchResponse::default());
    }
}
