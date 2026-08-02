//! Инвертированный индекс FSA (FSA.md §3): словарь термов, постинг-листы,
//! deletion-сигнатуры для fuzzy, tombstone-удаление и compact().
//!
//! Инварианты:
//! - постинг-листы отсортированы по внутреннему id документа (id растёт
//!   монотонно ⇒ вставка в конец сохраняет порядок);
//! - обновление документа = tombstone старой версии + новая версия с новым id;
//! - `df` терма учитывает tombstone-документы до `compact()` — это влияет
//!   только на idf (одинаково для всех документов) и не нарушает точность
//!   top-k относительно текущего состояния индекса.

use std::collections::{BTreeMap, HashMap};

use crate::fuzzy::{MAX_SIGNATURE_CHARS, deletion_hashes, within_distance};
use crate::text::fnv1a64;

/// Псевдо-поле атрибутов (фильтры точного совпадения).
pub(crate) const ATTR_FIELD: u8 = u8::MAX;

pub(crate) type TermId = u32;

/// Вхождение терма в конкретное поле документа.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FieldHit {
    pub field: u8,
    pub tf: u32,
    /// Позиции токена внутри поля; пусто, если позиции у поля выключены.
    pub positions: Vec<u32>,
}

/// Постинг: документ + вхождения по полям (поля в порядке профиля).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Posting {
    pub doc: u32,
    pub fields: Vec<FieldHit>,
}

#[derive(Debug)]
pub(crate) struct TermEntry {
    pub text: String,
    pub postings: Vec<Posting>,
}

#[derive(Debug)]
pub(crate) struct StoredDoc {
    pub ext_id: String,
    pub timestamp: i64,
    pub static_rank: f64,
    pub personal_keys: Vec<String>,
    /// Длина каждого текстового поля в токенах.
    pub field_len: Vec<u32>,
    /// Хеш полного нормализованного содержимого поля (0 — не вычислялся).
    pub field_hash: Vec<u64>,
    pub deleted: bool,
}

/// Подготовленный документ (анализ выполняет движок, хранение — индекс).
pub(crate) struct PreparedDoc {
    pub ext_id: String,
    pub timestamp: i64,
    pub static_rank: f64,
    pub personal_keys: Vec<String>,
    /// По полям профиля: список (терм, позиция); позиции монотонны.
    /// Сентинел `u32::MAX` — позиция не сохраняется (поле без positions).
    pub field_terms: Vec<Vec<(String, u32)>>,
    pub field_len: Vec<u32>,
    pub field_hash: Vec<u64>,
    /// Ключи атрибутов (уже в формате [`attr_term_key`]).
    pub attr_terms: Vec<String>,
}

/// Ключ атрибута в общем словаре термов. `\u{1}` не встречается в токенах
/// (токенизатор пропускает только alphanumeric), поэтому пространство имён
/// атрибутов не пересекается с термами и не участвует в префиксных сканах.
pub(crate) fn attr_term_key(name: &str, value: &str) -> String {
    format!("\u{1}{name}\u{1}{value}")
}

pub(crate) struct SearchIndex {
    field_count: usize,
    fuzzy_enabled: bool,
    term_ids: BTreeMap<String, TermId>,
    terms: Vec<TermEntry>,
    deletion_index: HashMap<u64, Vec<TermId>>,
    docs: Vec<StoredDoc>,
    ext_ids: HashMap<String, u32>,
    total_field_len: Vec<u64>,
    alive: u32,
}

impl SearchIndex {
    pub fn new(field_count: usize, fuzzy_enabled: bool) -> Self {
        Self {
            field_count,
            fuzzy_enabled,
            term_ids: BTreeMap::new(),
            terms: Vec::new(),
            deletion_index: HashMap::new(),
            docs: Vec::new(),
            ext_ids: HashMap::new(),
            total_field_len: vec![0; field_count],
            alive: 0,
        }
    }

    pub fn alive_docs(&self) -> u32 {
        self.alive
    }

    pub fn tombstones(&self) -> usize {
        self.docs.len() - self.alive as usize
    }

    pub fn contains(&self, ext_id: &str) -> bool {
        self.ext_ids.contains_key(ext_id)
    }

    pub fn doc(&self, doc: u32) -> &StoredDoc {
        &self.docs[doc as usize]
    }

    pub fn term_text(&self, term: TermId) -> &str {
        &self.terms[term as usize].text
    }

    pub fn postings(&self, term: TermId) -> &[Posting] {
        &self.terms[term as usize].postings
    }

    pub fn df(&self, term: TermId) -> usize {
        self.terms[term as usize].postings.len()
    }

    pub fn avg_field_len(&self, field: usize) -> f64 {
        if self.alive == 0 {
            return 1.0;
        }
        let avg = self.total_field_len[field] as f64 / f64::from(self.alive);
        if avg <= 0.0 { 1.0 } else { avg }
    }

    pub fn lookup(&self, term: &str) -> Option<TermId> {
        self.term_ids.get(term).copied()
    }

    /// Термы словаря с данным префиксом (лексикографический порядок), максимум
    /// `cap`. Сам префикс (точный терм) не включается — он отдельный вариант.
    pub fn prefix_terms(&self, prefix: &str, cap: usize) -> Vec<TermId> {
        let mut out = Vec::new();
        for (text, id) in self.term_ids.range(prefix.to_string()..) {
            if !text.starts_with(prefix) {
                break;
            }
            if text != prefix {
                out.push(*id);
                if out.len() >= cap {
                    break;
                }
            }
        }
        out
    }

    /// Fuzzy-кандидаты (d = 1) для токена запроса: SymSpell-пересечение
    /// deletion-сигнатур + верификация Дамерау—Левенштейном. Детерминированный
    /// порядок: df по убыванию, затем терм лексикографически.
    pub fn fuzzy_terms(&self, token: &str, cap: usize) -> Vec<TermId> {
        let token_chars = token.chars().count();
        if !(2..=MAX_SIGNATURE_CHARS).contains(&token_chars) {
            return Vec::new();
        }
        let mut candidates: Vec<TermId> = Vec::new();
        let push = |id: TermId, candidates: &mut Vec<TermId>| {
            if !candidates.contains(&id) {
                candidates.push(id);
            }
        };
        // Термы, для которых токен — их deletion-сигнатура (вставка в токен).
        if let Some(ids) = self.deletion_index.get(&fnv1a64(token.as_bytes())) {
            for id in ids {
                push(*id, &mut candidates);
            }
        }
        // Deletion-варианты токена: точный терм (удаление из токена) и
        // пересечение сигнатур (замена/транспозиция).
        let mut buf = String::with_capacity(token.len());
        let chars: Vec<char> = token.chars().collect();
        for skip in 0..chars.len() {
            buf.clear();
            for (i, c) in chars.iter().enumerate() {
                if i != skip {
                    buf.push(*c);
                }
            }
            if let Some(id) = self.lookup(&buf) {
                push(id, &mut candidates);
            }
            if let Some(ids) = self.deletion_index.get(&fnv1a64(buf.as_bytes())) {
                for id in ids {
                    push(*id, &mut candidates);
                }
            }
        }
        let mut verified: Vec<TermId> = candidates
            .into_iter()
            .filter(|id| {
                let text = self.term_text(*id);
                text != token && within_distance(token, text, 1)
            })
            .collect();
        verified.sort_by(|a, b| {
            self.df(*b)
                .cmp(&self.df(*a))
                .then_with(|| self.term_text(*a).cmp(self.term_text(*b)))
        });
        verified.truncate(cap);
        verified
    }

    fn intern(&mut self, text: &str, register_fuzzy: bool) -> TermId {
        if let Some(id) = self.term_ids.get(text) {
            return *id;
        }
        let id = u32::try_from(self.terms.len()).expect("term id overflow");
        self.term_ids.insert(text.to_string(), id);
        self.terms.push(TermEntry {
            text: text.to_string(),
            postings: Vec::new(),
        });
        if register_fuzzy && self.fuzzy_enabled {
            for hash in deletion_hashes(text) {
                self.deletion_index.entry(hash).or_default().push(id);
            }
        }
        id
    }

    /// Вставка новой версии документа. Возвращает внутренний id.
    pub fn insert(&mut self, prepared: PreparedDoc) -> u32 {
        debug_assert_eq!(prepared.field_terms.len(), self.field_count);
        if let Some(old) = self.ext_ids.get(&prepared.ext_id).copied() {
            self.soft_delete(old);
        }
        let doc_id = u32::try_from(self.docs.len()).expect("doc id overflow");

        // Терм → вхождения по полям (BTreeMap — детерминированный порядок
        // назначения TermId).
        let mut merged: BTreeMap<String, Vec<FieldHit>> = BTreeMap::new();
        for (field_idx, terms) in prepared.field_terms.iter().enumerate() {
            let field = u8::try_from(field_idx).expect("field id overflow");
            let mut per_term: BTreeMap<&str, FieldHit> = BTreeMap::new();
            for (term, position) in terms {
                let hit = per_term.entry(term.as_str()).or_insert_with(|| FieldHit {
                    field,
                    tf: 0,
                    positions: Vec::new(),
                });
                hit.tf += 1;
                if *position != u32::MAX {
                    hit.positions.push(*position);
                }
            }
            for (term, hit) in per_term {
                merged.entry(term.to_string()).or_default().push(hit);
            }
        }
        for (term, field_hits) in merged {
            let term_id = self.intern(&term, true);
            self.terms[term_id as usize].postings.push(Posting {
                doc: doc_id,
                fields: field_hits,
            });
        }
        for attr in &prepared.attr_terms {
            let term_id = self.intern(attr, false);
            self.terms[term_id as usize].postings.push(Posting {
                doc: doc_id,
                fields: vec![FieldHit {
                    field: ATTR_FIELD,
                    tf: 1,
                    positions: Vec::new(),
                }],
            });
        }
        for (field_idx, len) in prepared.field_len.iter().enumerate() {
            self.total_field_len[field_idx] += u64::from(*len);
        }
        self.ext_ids.insert(prepared.ext_id.clone(), doc_id);
        self.docs.push(StoredDoc {
            ext_id: prepared.ext_id,
            timestamp: prepared.timestamp,
            static_rank: prepared.static_rank,
            personal_keys: prepared.personal_keys,
            field_len: prepared.field_len,
            field_hash: prepared.field_hash,
            deleted: false,
        });
        self.alive += 1;
        doc_id
    }

    fn soft_delete(&mut self, doc: u32) {
        let idx = doc as usize;
        if self.docs[idx].deleted {
            return;
        }
        self.docs[idx].deleted = true;
        for field_idx in 0..self.field_count {
            self.total_field_len[field_idx] -= u64::from(self.docs[idx].field_len[field_idx]);
        }
        let ext_id = self.docs[idx].ext_id.clone();
        self.ext_ids.remove(&ext_id);
        self.alive -= 1;
    }

    /// Tombstone-удаление по внешнему id. `true`, если документ существовал.
    pub fn remove(&mut self, ext_id: &str) -> bool {
        match self.ext_ids.get(ext_id).copied() {
            Some(doc) => {
                self.soft_delete(doc);
                true
            }
            None => false,
        }
    }

    /// Полная перестройка без tombstone-документов: пересчитывает `df`,
    /// перенумеровывает документы, восстанавливает deletion-сигнатуры.
    pub fn compact(&mut self) {
        if self.tombstones() == 0 {
            return;
        }
        let mut remap: Vec<Option<u32>> = vec![None; self.docs.len()];
        let mut new_docs: Vec<StoredDoc> = Vec::with_capacity(self.alive as usize);
        for (old_id, doc) in self.docs.drain(..).enumerate() {
            if !doc.deleted {
                remap[old_id] = Some(u32::try_from(new_docs.len()).expect("doc id overflow"));
                new_docs.push(doc);
            }
        }

        let old_terms = std::mem::take(&mut self.terms);
        let old_term_ids = std::mem::take(&mut self.term_ids);
        self.deletion_index.clear();

        for (text, old_id) in old_term_ids {
            let entry = &old_terms[old_id as usize];
            let postings: Vec<Posting> = entry
                .postings
                .iter()
                .filter_map(|p| {
                    remap[p.doc as usize].map(|new_doc| Posting {
                        doc: new_doc,
                        fields: p.fields.clone(),
                    })
                })
                .collect();
            if postings.is_empty() {
                continue;
            }
            let is_attr = text.starts_with('\u{1}');
            let new_id = u32::try_from(self.terms.len()).expect("term id overflow");
            self.term_ids.insert(text.clone(), new_id);
            if !is_attr && self.fuzzy_enabled {
                for hash in deletion_hashes(&text) {
                    self.deletion_index.entry(hash).or_default().push(new_id);
                }
            }
            self.terms.push(TermEntry { text, postings });
        }

        self.ext_ids = new_docs
            .iter()
            .enumerate()
            .map(|(i, d)| (d.ext_id.clone(), u32::try_from(i).expect("doc id overflow")))
            .collect();
        self.docs = new_docs;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prepared(id: &str, terms: &[&str]) -> PreparedDoc {
        PreparedDoc {
            ext_id: id.to_string(),
            timestamp: 0,
            static_rank: 0.0,
            personal_keys: Vec::new(),
            field_terms: vec![
                terms
                    .iter()
                    .enumerate()
                    .map(|(i, t)| ((*t).to_string(), u32::try_from(i).unwrap()))
                    .collect(),
            ],
            field_len: vec![u32::try_from(terms.len()).unwrap()],
            field_hash: vec![0],
            attr_terms: vec![attr_term_key("kind", "post")],
        }
    }

    #[test]
    fn insert_lookup_and_postings() {
        let mut index = SearchIndex::new(1, true);
        index.insert(prepared("d1", &["hello", "world", "hello"]));
        index.insert(prepared("d2", &["hello"]));
        let hello = index.lookup("hello").expect("term");
        assert_eq!(index.df(hello), 2);
        assert_eq!(index.postings(hello)[0].fields[0].tf, 2);
        assert_eq!(index.postings(hello)[0].fields[0].positions, vec![0, 2]);
        assert_eq!(index.alive_docs(), 2);
        assert!(index.lookup(&attr_term_key("kind", "post")).is_some());
    }

    #[test]
    fn upsert_tombstones_previous_version() {
        let mut index = SearchIndex::new(1, false);
        index.insert(prepared("d1", &["old"]));
        index.insert(prepared("d1", &["new"]));
        assert_eq!(index.alive_docs(), 1);
        assert_eq!(index.tombstones(), 1);
        let old = index.lookup("old").expect("term survives until compact");
        assert_eq!(index.df(old), 1);
        assert!(index.doc(index.postings(old)[0].doc).deleted);
        index.compact();
        assert_eq!(index.tombstones(), 0);
        assert!(index.lookup("old").is_none());
        assert!(index.lookup("new").is_some());
        assert_eq!(index.alive_docs(), 1);
    }

    #[test]
    fn remove_and_compact_rebuilds_ids() {
        let mut index = SearchIndex::new(1, true);
        index.insert(prepared("d1", &["alpha", "shared"]));
        index.insert(prepared("d2", &["beta", "shared"]));
        assert!(index.remove("d1"));
        assert!(!index.remove("d1"));
        index.compact();
        let shared = index.lookup("shared").expect("term");
        assert_eq!(index.df(shared), 1);
        let posting_doc = index.postings(shared)[0].doc;
        assert_eq!(index.doc(posting_doc).ext_id, "d2");
        // Fuzzy-сигнатуры пересобраны: "betta" находит "beta".
        assert_eq!(index.fuzzy_terms("betta", 8).len(), 1);
    }

    #[test]
    fn prefix_scan_excludes_exact_and_attrs() {
        let mut index = SearchIndex::new(1, false);
        index.insert(prepared("d1", &["rock", "rocket", "rocky"]));
        let terms = index.prefix_terms("rock", 10);
        let texts: Vec<&str> = terms.iter().map(|t| index.term_text(*t)).collect();
        assert_eq!(texts, vec!["rocket", "rocky"]);
    }

    #[test]
    fn fuzzy_candidates_verified_by_distance() {
        let mut index = SearchIndex::new(1, true);
        index.insert(prepared("d1", &["metallica", "metal", "nirvana"]));
        let hits = index.fuzzy_terms("metalica", 8);
        let texts: Vec<&str> = hits.iter().map(|t| index.term_text(*t)).collect();
        assert!(texts.contains(&"metallica"));
        assert!(!texts.contains(&"nirvana"));
        // Точный терм не возвращается как fuzzy-вариант.
        let hits = index.fuzzy_terms("metal", 8);
        assert!(hits.iter().all(|t| index.term_text(*t) != "metal"));
    }

    #[test]
    fn avg_field_len_tracks_alive_docs() {
        let mut index = SearchIndex::new(1, false);
        index.insert(prepared("d1", &["a", "b", "c", "d"]));
        index.insert(prepared("d2", &["a", "b"]));
        assert_eq!(index.avg_field_len(0), 3.0);
        index.remove("d1");
        assert_eq!(index.avg_field_len(0), 2.0);
    }
}
