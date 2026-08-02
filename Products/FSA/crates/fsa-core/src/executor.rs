//! Исполнитель запроса (FSA.md §4): построение плана (варианты термов),
//! пересечение постинг-листов document-at-a-time с seek от самой редкой
//! группы, BM25F-скоринг, фразы/близость, блендинг свежести, static_rank
//! и персонализации, точный top-k.
//!
//! Гарантия качества (FSA.md §1): все отсечения — только по строгой
//! AND-семантике, не по эвристикам скоринга; ограниченная top-k куча + offset
//! дают в точности срез полного порядка (тест `bounded_top_k_equals_full_ranking_for_every_page`).

use std::cmp::Ordering;
use std::collections::BinaryHeap;

use crate::engine::SearchFilters;
use crate::index::{ATTR_FIELD, Posting, SearchIndex, TermId, attr_term_key};
use crate::personalization::{PersonalizationContext, blend_multiplier};
use crate::profile::{RecencyMode, SearchProfile};
use crate::query::{ParsedQuery, QueryAtom};
use crate::text::{joined_terms_hash, layout_alternative};

/// Нижняя граница idf: защищает от вырождения при `df > N` (tombstones).
const MIN_IDF: f64 = 1e-3;

pub(crate) struct ExecParams<'a> {
    pub profile: &'a SearchProfile,
    pub index: &'a SearchIndex,
    pub parsed: &'a ParsedQuery,
    pub filters: &'a SearchFilters,
    pub alpha: f64,
    pub context: Option<&'a PersonalizationContext>,
    pub now: i64,
    pub offset: usize,
    pub limit: usize,
}

pub(crate) struct ScoredDoc {
    pub doc: u32,
    pub score: f64,
    pub matched_terms: Vec<TermId>,
}

pub(crate) struct ExecOutcome {
    pub hits: Vec<ScoredDoc>,
    pub matched_total: usize,
}

impl ExecOutcome {
    fn empty() -> Self {
        Self {
            hits: Vec::new(),
            matched_total: 0,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Variant {
    term: TermId,
    penalty: f64,
}

struct Group {
    variants: Vec<Variant>,
    /// idf группы — по суммарному df вариантов (FSA.md §4.2): расширение
    /// (префикс/fuzzy) не выигрывает от собственной редкости, все документы
    /// группы скорятся в одном масштабе.
    idf: f64,
}

/// Курсор одного постинг-листа с продвижением только вперёд.
struct ListCursor<'a> {
    postings: &'a [Posting],
    pos: usize,
    variant: Variant,
}

impl<'a> ListCursor<'a> {
    fn current(&self) -> Option<u32> {
        self.postings.get(self.pos).map(|p| p.doc)
    }

    fn posting(&self) -> &'a Posting {
        &self.postings[self.pos]
    }

    /// Продвигает курсор к первому документу `>= target`.
    fn seek(&mut self, target: u32) {
        if self.postings.get(self.pos).is_some_and(|p| p.doc >= target) {
            return;
        }
        let advance = self.postings[self.pos..].partition_point(|p| p.doc < target);
        self.pos += advance;
    }
}

/// Union-курсор группы: минимум по вариантам, вклад — максимум по вариантам.
struct GroupCursor<'a> {
    lists: Vec<ListCursor<'a>>,
}

impl<'a> GroupCursor<'a> {
    fn seek(&mut self, target: u32) -> Option<u32> {
        let mut min: Option<u32> = None;
        for list in &mut self.lists {
            list.seek(target);
            if let Some(doc) = list.current() {
                min = Some(min.map_or(doc, |m: u32| m.min(doc)));
            }
        }
        min
    }

    fn matched_lists(&self, doc: u32) -> impl Iterator<Item = &ListCursor<'a>> {
        self.lists.iter().filter(move |l| l.current() == Some(doc))
    }
}

/// Кандидат в top-k куче. `Ord`: наибольший = худший по нормативному порядку
/// (`key0 desc → key1 desc → ext_id asc`), т.е. куча-максимум держит худшего
/// наверху и вытесняет его первым.
struct Candidate {
    key0: f64,
    key1: f64,
    ext_id: String,
    doc: u32,
    score: f64,
    matched_terms: Vec<TermId>,
}

impl Candidate {
    /// `Less` ⇔ `self` ранжируется раньше (лучше) `other`.
    fn better(&self, other: &Self) -> Ordering {
        other
            .key0
            .total_cmp(&self.key0)
            .then_with(|| other.key1.total_cmp(&self.key1))
            .then_with(|| self.ext_id.cmp(&other.ext_id))
    }
}

impl PartialEq for Candidate {
    fn eq(&self, other: &Self) -> bool {
        self.better(other) == Ordering::Equal
    }
}
impl Eq for Candidate {}
impl PartialOrd for Candidate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Candidate {
    fn cmp(&self, other: &Self) -> Ordering {
        self.better(other)
    }
}

fn idf_for_df(alive_docs: u32, df: usize) -> f64 {
    let n = f64::from(alive_docs.max(1));
    let df = df as f64;
    let raw = (1.0 + (n - df + 0.5) / (df + 0.5)).max(1.0 + MIN_IDF).ln();
    raw.max(MIN_IDF)
}

fn group_from_variants(index: &SearchIndex, variants: Vec<Variant>) -> Group {
    let total_df: usize = variants.iter().map(|v| index.df(v.term)).sum();
    Group {
        idf: idf_for_df(index.alive_docs(), total_df),
        variants,
    }
}

/// Варианты одного токена запроса (FSA.md §3.2). Дедупликация по терму —
/// максимум штрафа; детерминированный порядок по `TermId`.
fn build_variants(
    token: &str,
    is_last: bool,
    profile: &SearchProfile,
    index: &SearchIndex,
) -> Vec<Variant> {
    let policy = &profile.expansion;
    let chars = token.chars().count();
    let mut raw: Vec<(TermId, f64)> = Vec::new();

    if let Some(exact) = index.lookup(token) {
        raw.push((exact, 1.0));
    }
    if policy.layout_correction
        && let Some(alt) = layout_alternative(token)
        && let Some(term) = index.lookup(&alt)
    {
        raw.push((term, policy.layout_penalty));
    }
    if policy.prefix_min_chars > 0
        && chars >= policy.prefix_min_chars
        && (is_last || !policy.prefix_last_token_only)
    {
        for term in index.prefix_terms(token, policy.prefix_max_terms) {
            raw.push((term, policy.prefix_penalty));
        }
    }
    if policy.fuzzy_min_chars > 0 && chars >= policy.fuzzy_min_chars {
        for term in index.fuzzy_terms(token, policy.fuzzy_max_candidates) {
            raw.push((term, policy.fuzzy_penalty));
        }
    }

    raw.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.total_cmp(&a.1)));
    raw.dedup_by_key(|v| v.0);
    raw.into_iter()
        .map(|(term, penalty)| Variant { term, penalty })
        .collect()
}

/// Отсортированный union документов, имеющих любой из атрибутов группы.
fn merged_attr_docs(index: &SearchIndex, alternatives: &[(String, String)]) -> Vec<u32> {
    let mut docs: Vec<u32> = Vec::new();
    for (name, value) in alternatives {
        if let Some(term) = index.lookup(&attr_term_key(name, value)) {
            docs.extend(index.postings(term).iter().map(|p| p.doc));
        }
    }
    docs.sort_unstable();
    docs.dedup();
    docs
}

fn postings_contain(postings: &[Posting], doc: u32) -> bool {
    postings.binary_search_by(|p| p.doc.cmp(&doc)).is_ok()
}

/// Минимальный span окна, покрывающего по одной позиции каждой группы.
/// `entries` — (позиция, группа), отсортировано по позиции.
fn min_window_span(entries: &[(u32, usize)], group_count: usize) -> Option<u32> {
    let mut counts = vec![0usize; group_count];
    let mut covered = 0usize;
    let mut best: Option<u32> = None;
    let mut left = 0usize;
    for right in 0..entries.len() {
        let g = entries[right].1;
        if counts[g] == 0 {
            covered += 1;
        }
        counts[g] += 1;
        while covered == group_count {
            let span = entries[right].0 - entries[left].0 + 1;
            best = Some(best.map_or(span, |b: u32| b.min(span)));
            let lg = entries[left].1;
            counts[lg] -= 1;
            if counts[lg] == 0 {
                covered -= 1;
            }
            left += 1;
        }
    }
    best
}

pub(crate) fn execute(params: &ExecParams<'_>) -> ExecOutcome {
    let profile = params.profile;
    let index = params.index;
    let parsed = params.parsed;

    if parsed.is_empty() || index.alive_docs() == 0 {
        return ExecOutcome::empty();
    }

    // --- План: группы вариантов + фразовые ограничения ---
    let last_term_atom = parsed
        .positives
        .iter()
        .rposition(|a| matches!(a, QueryAtom::Term(_)));
    let mut groups: Vec<Group> = Vec::new();
    let mut phrases: Vec<Vec<usize>> = Vec::new();
    for (atom_idx, atom) in parsed.positives.iter().enumerate() {
        match atom {
            QueryAtom::Term(token) => {
                let variants =
                    build_variants(token, last_term_atom == Some(atom_idx), profile, index);
                if variants.is_empty() {
                    return ExecOutcome::empty();
                }
                groups.push(group_from_variants(index, variants));
            }
            QueryAtom::Phrase(tokens) => {
                let mut phrase_groups = Vec::with_capacity(tokens.len());
                for token in tokens {
                    let Some(term) = index.lookup(token) else {
                        return ExecOutcome::empty();
                    };
                    phrase_groups.push(groups.len());
                    groups.push(group_from_variants(
                        index,
                        vec![Variant { term, penalty: 1.0 }],
                    ));
                }
                phrases.push(phrase_groups);
            }
        }
    }

    // --- Фильтры и исключения ---
    let mut all_of_lists: Vec<&[Posting]> = Vec::new();
    for (name, value) in &params.filters.all_of {
        match index.lookup(&attr_term_key(name, value)) {
            Some(term) => all_of_lists.push(index.postings(term)),
            None => return ExecOutcome::empty(),
        }
    }
    let mut any_of_merged: Vec<Vec<u32>> = Vec::new();
    for alternatives in &params.filters.any_of {
        let merged = merged_attr_docs(index, alternatives);
        if merged.is_empty() {
            return ExecOutcome::empty();
        }
        any_of_merged.push(merged);
    }
    let none_of_lists: Vec<&[Posting]> = params
        .filters
        .none_of
        .iter()
        .filter_map(|(name, value)| index.lookup(&attr_term_key(name, value)))
        .map(|term| index.postings(term))
        .collect();
    let negative_lists: Vec<&[Posting]> = parsed
        .negatives
        .iter()
        .filter_map(|token| index.lookup(token))
        .map(|term| index.postings(term))
        .collect();

    // --- Курсоры; порядок пересечения — от самой редкой группы ---
    let mut group_order: Vec<usize> = (0..groups.len()).collect();
    let group_df = |g: &Group| -> usize { g.variants.iter().map(|v| index.df(v.term)).sum() };
    group_order.sort_by_key(|gi| group_df(&groups[*gi]));

    let mut cursors: Vec<GroupCursor<'_>> = groups
        .iter()
        .map(|g| GroupCursor {
            lists: g
                .variants
                .iter()
                .map(|v| ListCursor {
                    postings: index.postings(v.term),
                    pos: 0,
                    variant: *v,
                })
                .collect(),
        })
        .collect();

    // --- Предвычисления скоринга ---
    let field_count = profile.fields.len();
    let mut field_weight = vec![0.0f64; field_count];
    let mut field_b = vec![0.0f64; field_count];
    let mut field_avg = vec![1.0f64; field_count];
    for (f, spec) in profile.fields.iter().enumerate() {
        field_weight[f] = spec.weight;
        field_b[f] = spec.b;
        field_avg[f] = index.avg_field_len(f);
    }
    let k1 = profile.ranking.k1;
    let query_hash = {
        let flat = parsed.flat_positive_terms();
        if flat.is_empty() {
            0
        } else {
            joined_terms_hash(flat.into_iter())
        }
    };
    let has_exact_boost = profile.fields.iter().any(|f| f.exact_boost > 0.0);
    let alpha = params.alpha;
    let lambda = profile.personalization.lambda;
    let any_positions = profile.any_positions();
    let want_proximity =
        profile.ranking.proximity_weight > 0.0 && groups.len() >= 2 && any_positions;

    let capacity = params.offset.saturating_add(params.limit).max(1);
    let mut heap: BinaryHeap<Candidate> = BinaryHeap::with_capacity(capacity + 1);
    let mut matched_total = 0usize;

    // Вклад группы в S_text (FSA.md §4.2): насыщение per-field, вес поля
    // снаружи — короткие сильные поля (title, name) доминируют честно:
    //   contribution = idf_группы × max_по_вариантам(penalty × Σ_f w_f · sat_f),
    //   sat_f = tfn_f / (k1 + tfn_f),  tfn_f = tf_f / B_f.
    let group_contribution =
        |group: &Group, cursor: &GroupCursor<'_>, doc: u32, doc_field_len: &[u32]| {
            let mut best = 0.0f64;
            let mut best_term: Option<TermId> = None;
            for list in cursor.matched_lists(doc) {
                let posting = list.posting();
                let mut weighted = 0.0f64;
                for hit in &posting.fields {
                    if hit.field == ATTR_FIELD {
                        continue;
                    }
                    let f = hit.field as usize;
                    let len = f64::from(doc_field_len[f]);
                    let b = field_b[f];
                    let norm = (1.0 - b) + b * (len / field_avg[f]);
                    let tfn = f64::from(hit.tf) / norm;
                    weighted += field_weight[f] * (tfn / (k1 + tfn));
                }
                if weighted <= 0.0 {
                    continue;
                }
                let contribution = list.variant.penalty * weighted;
                if contribution > best {
                    best = contribution;
                    best_term = Some(list.variant.term);
                }
            }
            (group.idf * best, best_term)
        };

    // --- Пересечение document-at-a-time ---
    let mut target = 0u32;
    // Драйвер — самая редкая группа; None ⇒ постинги исчерпаны.
    'outer: while let Some(mut doc) = cursors[group_order[0]].seek(target) {
        // Согласование всех групп на одном документе.
        let mut settled = false;
        while !settled {
            settled = true;
            for gi in &group_order {
                match cursors[*gi].seek(doc) {
                    None => break 'outer,
                    Some(d) if d > doc => {
                        doc = d;
                        settled = false;
                        break;
                    }
                    Some(_) => {}
                }
            }
        }
        target = doc.saturating_add(1);

        let stored = index.doc(doc);
        if stored.deleted {
            continue;
        }
        if !all_of_lists.iter().all(|l| postings_contain(l, doc)) {
            continue;
        }
        if !any_of_merged.iter().all(|m| m.binary_search(&doc).is_ok()) {
            continue;
        }
        if none_of_lists.iter().any(|l| postings_contain(l, doc)) {
            continue;
        }
        if negative_lists.iter().any(|l| postings_contain(l, doc)) {
            continue;
        }

        // Фразы: смежность позиций в одном поле (при наличии позиций).
        if any_positions && !phrases.is_empty() {
            let phrases_ok = phrases.iter().all(|phrase_groups| {
                (0..field_count).any(|f| {
                    if !profile.fields[f].positions {
                        return false;
                    }
                    let per_group: Vec<&[u32]> = phrase_groups
                        .iter()
                        .filter_map(|gi| {
                            cursors[*gi].matched_lists(doc).next().and_then(|list| {
                                list.posting()
                                    .fields
                                    .iter()
                                    .find(|h| h.field as usize == f)
                                    .map(|h| h.positions.as_slice())
                            })
                        })
                        .collect();
                    if per_group.len() != phrase_groups.len()
                        || per_group.iter().any(|p| p.is_empty())
                    {
                        return false;
                    }
                    per_group[0].iter().any(|start| {
                        per_group.iter().enumerate().skip(1).all(|(i, positions)| {
                            let want = start + u32::try_from(i).unwrap_or(u32::MAX);
                            positions.binary_search(&want).is_ok()
                        })
                    })
                })
            });
            if !phrases_ok {
                continue;
            }
        }

        // --- Скоринг ---
        let mut s_text = 0.0f64;
        let mut matched_terms: Vec<TermId> = Vec::with_capacity(groups.len());
        let mut all_groups_scored = true;
        for (group, cursor) in groups.iter().zip(&cursors) {
            let (contribution, term) = group_contribution(group, cursor, doc, &stored.field_len);
            if contribution <= 0.0 {
                all_groups_scored = false;
                break;
            }
            s_text += contribution;
            if let Some(term) = term {
                matched_terms.push(term);
            }
        }
        if !all_groups_scored {
            // Совпадение только по атрибутному псевдо-полю — не текстовый матч.
            continue;
        }

        // Proximity-бонус: лучшее (минимальное) окно по каждому позиционному полю.
        if want_proximity {
            let mut best_tightness = 0.0f64;
            for f in 0..field_count {
                if !profile.fields[f].positions {
                    continue;
                }
                let mut entries: Vec<(u32, usize)> = Vec::new();
                let mut groups_present = 0usize;
                for (gi, cursor) in cursors.iter().enumerate() {
                    let mut present = false;
                    for list in cursor.matched_lists(doc) {
                        if let Some(hit) =
                            list.posting().fields.iter().find(|h| h.field as usize == f)
                        {
                            for p in &hit.positions {
                                entries.push((*p, gi));
                                present = true;
                            }
                        }
                    }
                    if present {
                        groups_present += 1;
                    }
                }
                if groups_present != cursors.len() {
                    continue;
                }
                entries.sort_unstable();
                if let Some(span) = min_window_span(&entries, cursors.len()) {
                    let tightness = (groups.len() as f64 / f64::from(span)).min(1.0);
                    if tightness > best_tightness {
                        best_tightness = tightness;
                    }
                }
            }
            s_text += profile.ranking.proximity_weight * best_tightness;
        }

        // Точное совпадение всего поля с запросом.
        if has_exact_boost && query_hash != 0 {
            let mut boost = 0.0f64;
            for (f, spec) in profile.fields.iter().enumerate() {
                if spec.exact_boost > 0.0
                    && stored.field_hash[f] != 0
                    && stored.field_hash[f] == query_hash
                    && spec.exact_boost > boost
                {
                    boost = spec.exact_boost;
                }
            }
            s_text *= 1.0 + boost;
        }

        // Статический приоритет.
        if profile.ranking.static_rank_weight > 0.0 {
            s_text *= 1.0 + profile.ranking.static_rank_weight * stored.static_rank;
        }

        // Свежесть.
        if let RecencyMode::Boost {
            half_life_secs,
            weight,
        } = profile.ranking.recency
        {
            let age = (params.now - stored.timestamp).max(0) as f64;
            let decay = (-age / half_life_secs as f64).exp2();
            s_text *= 1.0 + weight * decay;
        }

        // Персонализация (FSA.md §5): только переупорядочивание, не отбор.
        let affinity = match (params.context, alpha > 0.0 && lambda > 0.0) {
            (Some(ctx), true) => ctx.affinity_max(&stored.personal_keys),
            _ => 0.0,
        };
        let score = s_text * blend_multiplier(alpha, lambda, affinity);

        matched_total += 1;
        let (key0, key1) = match profile.ranking.recency {
            RecencyMode::Primary => (stored.timestamp as f64, score),
            _ => (score, stored.timestamp as f64),
        };

        // Быстрый путь без клона ext_id: пустой ext_id ранжирует пробу
        // лучше-или-равно реальному кандидату, поэтому «худший в куче лучше
        // пробы» ⇒ реальный кандидат тоже хуже худшего.
        if heap.len() >= capacity {
            let probe = Candidate {
                key0,
                key1,
                ext_id: String::new(),
                doc,
                score,
                matched_terms: Vec::new(),
            };
            if heap
                .peek()
                .is_some_and(|worst| worst.better(&probe) == Ordering::Less)
            {
                continue;
            }
        }
        let candidate = Candidate {
            key0,
            key1,
            ext_id: stored.ext_id.clone(),
            doc,
            score,
            matched_terms,
        };
        if heap.len() < capacity {
            heap.push(candidate);
        } else if heap
            .peek()
            .is_some_and(|worst| candidate.better(worst) == Ordering::Less)
        {
            heap.pop();
            heap.push(candidate);
        }
    }

    let mut ranked: Vec<Candidate> = heap.into_vec();
    ranked.sort_by(Candidate::better);
    let hits = ranked
        .into_iter()
        .skip(params.offset)
        .take(params.limit)
        .map(|c| ScoredDoc {
            doc: c.doc,
            score: c.score,
            matched_terms: c.matched_terms,
        })
        .collect();

    ExecOutcome {
        hits,
        matched_total,
    }
}
