//! Сквозные инварианты FSA (FSA.md §5.3, §7), проверяемые через публичный API:
//!
//! 1. `α = 0` ⇔ персонализация выключена: выдача бит-в-бит совпадает
//!    с запросом без контекста (никакой интеграции с FIRA).
//! 2. Монотонность α: рост уровня не понижает скор документа с аффинити
//!    и не меняет скоры документов без аффинити.
//! 3. Персонализация меняет только порядок, но не состав выдачи.
//! 4. Детерминизм: повторные запросы и другой порядок индексации дают
//!    идентичный результат (tie-break по внешнему id).

use fsa_core::{
    AffinityEntry, AffinitySnapshot, Document, EngineLimits, ExpansionPolicy, FieldSpec,
    PersonalizationContext, PersonalizationLevel, PersonalizationPolicy, RankingParams,
    SearchDomain, SearchEngine, SearchProfile, SearchRequest, affinity_key,
};

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

/// (id, title, body, автор personal-key).
const DOCS: [(&str, &str, &str, &str); 4] = [
    ("d1", "rust поиск", "интро в полнотекстовый поиск", "u1"),
    ("d2", "rust ядро", "поиск rust внутри ядра", "u2"),
    ("d3", "заметки", "поиск по rust проектам", "u3"),
    ("d4", "прочее", "ничего общего", "u4"),
];

fn engine(order: &[usize]) -> SearchEngine {
    let mut engine = SearchEngine::new(profile()).expect("profile");
    for &i in order {
        let (id, title, body, author) = DOCS[i];
        engine
            .upsert(
                Document::new(id)
                    .field("title", title)
                    .field("body", body)
                    .personal_key(affinity_key::author(author)),
            )
            .expect("upsert");
    }
    engine
}

fn context_for(author: &str, weight: f64) -> PersonalizationContext {
    PersonalizationContext::from_snapshot(&AffinitySnapshot {
        entries: vec![AffinityEntry {
            key: affinity_key::author(author),
            weight,
        }],
        generated_at: None,
    })
}

fn request(alpha: f64) -> SearchRequest {
    SearchRequest::new("rust поиск", 0).personalization(PersonalizationLevel::new(alpha))
}

#[test]
fn alpha_zero_is_bit_identical_to_disabled_personalization() {
    let engine = engine(&[0, 1, 2, 3]);
    let context = context_for("u3", 1.0);

    let without_context = engine.search(&request(0.0), None);
    let zero_alpha = engine.search(&request(0.0), Some(&context));
    let max_alpha_empty_context =
        engine.search(&request(1.0), Some(&PersonalizationContext::new()));

    assert_eq!(zero_alpha, without_context, "α=0: контекст не влияет");
    assert_eq!(
        max_alpha_empty_context, without_context,
        "пустой контекст: α не влияет"
    );
    assert!(!without_context.hits.is_empty());
}

#[test]
fn alpha_is_monotonic_and_touches_only_affine_docs() {
    let engine = engine(&[0, 1, 2, 3]);
    let context = context_for("u3", 0.8);

    let mut previous_affine_score = 0.0f64;
    let baseline = engine.search(&request(0.0), Some(&context));
    let score_of = |response: &fsa_core::SearchResponse, id: &str| {
        response
            .hits
            .iter()
            .find(|h| h.id == id)
            .map(|h| h.score)
            .expect("hit present")
    };

    for alpha in [0.0, 0.25, 0.5, 0.75, 1.0] {
        let response = engine.search(&request(alpha), Some(&context));
        // Документы без аффинити не двигаются по скору.
        for id in ["d1", "d2"] {
            assert_eq!(
                score_of(&response, id),
                score_of(&baseline, id),
                "α={alpha}: скор документа без аффинити неизменен"
            );
        }
        // Документ с аффинити монотонно растёт.
        let affine = score_of(&response, "d3");
        assert!(
            affine >= previous_affine_score,
            "α={alpha}: скор аффинити-документа не убывает"
        );
        previous_affine_score = affine;
    }

    // При α=1 множитель равен 1 + λ·A ровно.
    let base = score_of(&baseline, "d3");
    let boosted = score_of(&engine.search(&request(1.0), Some(&context)), "d3");
    assert!((boosted - base * (1.0 + 0.8)).abs() < 1e-12);
}

#[test]
fn personalization_never_changes_result_set() {
    let engine = engine(&[0, 1, 2, 3]);
    let context = context_for("u3", 1.0);

    let neutral = engine.search(&request(0.0), None);
    let personalized = engine.search(&request(1.0), Some(&context));

    assert_eq!(neutral.matched_total, personalized.matched_total);
    let mut neutral_ids: Vec<_> = neutral.hits.iter().map(|h| h.id.as_str()).collect();
    let mut personalized_ids: Vec<_> = personalized.hits.iter().map(|h| h.id.as_str()).collect();
    neutral_ids.sort_unstable();
    personalized_ids.sort_unstable();
    assert_eq!(
        neutral_ids, personalized_ids,
        "персонализация не добавляет и не убирает документы"
    );
}

#[test]
fn bounded_top_k_equals_full_ranking_for_every_page() {
    // «Скорость без потери качества» (FSA.md §1, §4.6): ограниченная top-k куча
    // + offset обязаны давать в точности срез полного порядка. Полный прогон
    // (limit = все документы) — эталон; любой (offset, limit) — его срез.
    let engine = engine(&[0, 1, 2, 3]);
    let context = context_for("u2", 0.5);

    for alpha in [0.0, 0.5, 1.0] {
        let full = engine.search(&request(alpha).limit(usize::from(u8::MAX)), Some(&context));
        let reference: Vec<(String, f64)> =
            full.hits.iter().map(|h| (h.id.clone(), h.score)).collect();
        let n = reference.len();
        assert!(n >= 3, "нужно несколько документов для проверки срезов");

        for limit in 1..=n {
            for offset in 0..=n {
                let page =
                    engine.search(&request(alpha).limit(limit).offset(offset), Some(&context));
                let expected: Vec<(String, f64)> =
                    reference.iter().skip(offset).take(limit).cloned().collect();
                let actual: Vec<(String, f64)> =
                    page.hits.iter().map(|h| (h.id.clone(), h.score)).collect();
                assert_eq!(
                    actual, expected,
                    "α={alpha} offset={offset} limit={limit}: срез расходится с полным порядком"
                );
                assert_eq!(
                    page.matched_total, n,
                    "matched_total не зависит от окна выдачи"
                );
            }
        }
    }
}

#[test]
fn search_is_deterministic_across_runs_and_insertion_orders() {
    let forward = engine(&[0, 1, 2, 3]);
    let shuffled = engine(&[3, 1, 0, 2]);
    let context = context_for("u2", 0.6);

    let reference = forward.search(&request(0.7), Some(&context));
    for _ in 0..10 {
        assert_eq!(
            forward.search(&request(0.7), Some(&context)),
            reference,
            "повторный запрос детерминирован"
        );
    }

    let other = shuffled.search(&request(0.7), Some(&context));
    let ids_scores = |r: &fsa_core::SearchResponse| {
        r.hits
            .iter()
            .map(|h| (h.id.clone(), h.score))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        ids_scores(&reference),
        ids_scores(&other),
        "порядок индексации не влияет на выдачу"
    );
}
