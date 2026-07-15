//! Паритет скореров FIRA с C#-эталоном (golden-вектора `Documents/test-vectors/fira/`, FIRA.md §15).
//!
//! Score сравнивается с относительным допуском `scoreToleranceRelative` из вектора
//! (трансцендентные ln/exp/tanh могут расходиться на ~1 ulp между libm-реализациями);
//! ожидаемый точный 0 обязан быть точным 0. Порядок ранжирования и позиционная
//! постобработка сравниваются точно.

use chrono::{DateTime, Utc};
use flora_parity::{fira_vectors_dir, load_json};
use serde_json::Value;
use uuid::Uuid;

use flora_content::application::communities as fira_c;
use flora_content::application::feed as fira_f;
use flora_music::application::recommendations as fira_m;
use flora_users::application::people as fira_p;

fn vector(name: &str) -> Value {
    load_json(&fira_vectors_dir().join(name)).expect(
        "нет вектора FIRA — сгенерируйте из C#-эталона: ./Scripts/generate-golden-vectors.ps1",
    )
}

fn utc(v: &Value) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(v.as_str().expect("строка даты"))
        .expect("ISO 8601 UTC")
        .with_timezone(&Utc)
}

fn uid(v: &Value) -> Uuid {
    v.as_str().expect("строка uuid").parse().expect("uuid")
}

fn f64_of(v: &Value) -> f64 {
    v.as_f64().expect("число f64")
}

fn i32_of(v: &Value) -> i32 {
    i32::try_from(v.as_i64().expect("целое")).expect("в диапазоне i32")
}

/// Допусковое сравнение score: ожидаемый 0 — точный; иначе относительная разница ≤ rel_tol.
fn assert_close(actual: f64, expected: f64, rel_tol: f64, ctx: &str) {
    if expected == 0.0 {
        assert_eq!(actual, 0.0, "{ctx}: ожидался точный 0, получено {actual:e}");
        return;
    }
    let scale = expected.abs().max(actual.abs());
    let rel = (actual - expected).abs() / scale;
    assert!(
        rel <= rel_tol,
        "{ctx}: actual={actual:.17e} expected={expected:.17e} rel={rel:e} > {rel_tol:e}",
    );
}

fn expected_order(v: &Value) -> Vec<String> {
    v.as_array()
        .expect("массив expectedOrder")
        .iter()
        .map(|s| s.as_str().expect("uuid-строка").to_string())
        .collect()
}

// ─── FIRA-F: скорер ─────────────────────────────────────────────────────────

fn feed_config(v: &Value) -> fira_f::FiraFeedConfig {
    fira_f::FiraFeedConfig {
        alpha_phase0: f64_of(&v["alphaPhase0"]),
        beta_phase0: f64_of(&v["betaPhase0"]),
        gamma_phase0: f64_of(&v["gammaPhase0"]),
        decay_lambda: f64_of(&v["decayLambda"]),
        author_affinity_scale: f64_of(&v["authorAffinityScale"]),
        affinity_threshold: f64_of(&v["affinityThreshold"]),
        social_repost_threshold: i32_of(&v["socialRepostThreshold"]),
        repost_weight: f64_of(&v["repostWeight"]),
        repost_cap: f64_of(&v["repostCap"]),
        ..Default::default()
    }
}

/// Кандидат из вектора; `authorAffinity` берётся как есть (точное f64 из C#),
/// чтобы проверки downstream-компонентов не зависели от допусков tanh.
fn feed_candidate(v: &Value) -> fira_f::FeedCandidate {
    fira_f::FeedCandidate {
        post_uuid: uid(&v["postUuid"]),
        author_user_uuid: uid(&v["authorUserUuid"]),
        created_at: utc(&v["createdAt"]),
        likes_48h: i32_of(&v["likes48h"]),
        comments_48h: i32_of(&v["comments48h"]),
        reposts_48h: i32_of(&v["reposts48h"]),
        views_48h: i32_of(&v["views48h"]),
        author_follower_count: i32_of(&v["authorFollowerCount"]),
        author_affinity: f64_of(&v["authorAffinity"]),
        followed_likers_count: i32_of(&v["followedLikersCount"]),
        followed_reposters_count: i32_of(&v["followedRepostersCount"]),
        pool_weight: 1.0,
    }
}

#[test]
fn fira_f_scorer_components_match_csharp() {
    let v = vector("fira-f-scorer-v1.json");
    let cfg = feed_config(&v["config"]);
    let now = utc(&v["nowUtc"]);
    let tol = f64_of(&v["scoreToleranceRelative"]);

    for case in v["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().unwrap();
        let c = feed_candidate(&case["candidate"]);
        let expected = &case["expected"];

        let raw = f64_of(&case["candidate"]["rawAuthorInteractionScore"]);
        assert_close(
            fira_f::author_affinity(raw, cfg.author_affinity_scale),
            f64_of(&expected["authorAffinity"]),
            tol,
            &format!("{name}: authorAffinity"),
        );

        let ia = fira_f::individual_affinity(&c);
        assert_close(
            ia,
            f64_of(&expected["individualAffinity"]),
            tol,
            &format!("{name}: individualAffinity"),
        );
        assert_close(
            fira_f::global_relevance(&c, &cfg, now),
            f64_of(&expected["globalRelevance"]),
            tol,
            &format!("{name}: globalRelevance"),
        );
        assert_close(
            fira_f::social_proximity(&c, ia, &cfg),
            f64_of(&expected["socialProximity"]),
            tol,
            &format!("{name}: socialProximity"),
        );
        assert_close(
            fira_f::repost_boost(&c, ia, &cfg),
            f64_of(&expected["repostBoost"]),
            tol,
            &format!("{name}: repostBoost"),
        );
        assert_close(
            fira_f::score(&c, &cfg, now),
            f64_of(&expected["score"]),
            tol,
            &format!("{name}: score"),
        );
    }
}

#[test]
fn fira_f_ranking_matches_csharp() {
    let v = vector("fira-f-scorer-v1.json");
    let cfg = feed_config(&v["config"]);
    let now = utc(&v["nowUtc"]);

    let candidates: Vec<fira_f::FeedCandidate> = v["ranking"]["candidates"]
        .as_array()
        .expect("ranking.candidates")
        .iter()
        .map(feed_candidate)
        .collect();

    let actual: Vec<String> = fira_f::rank(&candidates, &cfg, now)
        .iter()
        .map(|c| c.post_uuid.to_string())
        .collect();
    assert_eq!(actual, expected_order(&v["ranking"]["expectedOrder"]));
}

// ─── FIRA-F: постобработка ──────────────────────────────────────────────────

#[test]
fn fira_f_author_diversity_matches_csharp() {
    let v = vector("fira-f-postprocessing-v1.json");

    for case in v["authorDiversity"].as_array().expect("authorDiversity") {
        let name = case["name"].as_str().unwrap();
        let items: Vec<fira_f::FeedCandidate> = case["items"]
            .as_array()
            .expect("items")
            .iter()
            .map(|item| fira_f::FeedCandidate {
                post_uuid: uid(&item["postUuid"]),
                author_user_uuid: uid(&item["authorUserUuid"]),
                created_at: DateTime::<Utc>::UNIX_EPOCH,
                likes_48h: 0,
                comments_48h: 0,
                reposts_48h: 0,
                views_48h: 0,
                author_follower_count: 0,
                author_affinity: 0.0,
                followed_likers_count: 0,
                followed_reposters_count: 0,
                pool_weight: 1.0,
            })
            .collect();

        let actual: Vec<String> =
            fira_f::apply_author_diversity(&items, i32_of(&case["maxConsecutiveSameAuthor"]))
                .iter()
                .map(|c| c.post_uuid.to_string())
                .collect();
        assert_eq!(
            actual,
            expected_order(&case["expectedOrder"]),
            "case={name}"
        );
    }
}

#[test]
fn fira_f_interleave_exploration_matches_csharp() {
    let v = vector("fira-f-postprocessing-v1.json");

    for case in v["interleaveExploration"]
        .as_array()
        .expect("interleaveExploration")
    {
        let name = case["name"].as_str().unwrap();
        let quota = f64_of(&case["explorationQuota"]);

        assert_eq!(
            fira_f::exploration_period(quota),
            usize::try_from(case["expectedPeriod"].as_i64().unwrap()).unwrap(),
            "case={name}: period",
        );

        let main: Vec<Uuid> = case["main"].as_array().unwrap().iter().map(uid).collect();
        let exploration: Vec<Uuid> = case["exploration"]
            .as_array()
            .unwrap()
            .iter()
            .map(uid)
            .collect();

        let actual: Vec<String> = fira_f::interleave_exploration(main, &exploration, quota)
            .iter()
            .map(Uuid::to_string)
            .collect();
        assert_eq!(
            actual,
            expected_order(&case["expectedOrder"]),
            "case={name}"
        );
    }
}

// ─── FIRA-C ─────────────────────────────────────────────────────────────────

fn community_options(v: &Value) -> fira_c::CommunityRecommendationOptions {
    fira_c::CommunityRecommendationOptions {
        weight_members: f64_of(&v["weightMembers"]),
        weight_activity: f64_of(&v["weightActivity"]),
        weight_social: f64_of(&v["weightSocial"]),
        weight_recency: f64_of(&v["weightRecency"]),
        new_community_boost_days: i32_of(&v["newCommunityBoostDays"]),
        ..Default::default()
    }
}

fn community_candidate(v: &Value) -> fira_c::CommunityCandidate {
    fira_c::CommunityCandidate {
        community_id: uid(&v["communityId"]),
        name: v["name"].as_str().expect("name").to_string(),
        created_at: utc(&v["createdAt"]),
        member_count: i32_of(&v["memberCount"]),
        recent_post_count: i32_of(&v["recentPostCount"]),
        followed_members_count: i32_of(&v["followedMembersCount"]),
    }
}

#[test]
fn fira_c_scorer_matches_csharp() {
    let v = vector("fira-c-scorer-v1.json");
    let options = community_options(&v["options"]);
    let now = utc(&v["nowUtc"]);
    let tol = f64_of(&v["scoreToleranceRelative"]);

    for case in v["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().unwrap();
        assert_close(
            fira_c::score(&community_candidate(&case["candidate"]), &options, now),
            f64_of(&case["expectedScore"]),
            tol,
            &format!("{name}: score"),
        );
    }

    let candidates: Vec<fira_c::CommunityCandidate> = v["ranking"]["candidates"]
        .as_array()
        .expect("ranking.candidates")
        .iter()
        .map(community_candidate)
        .collect();
    let actual: Vec<String> = fira_c::rank(&candidates, &options, now)
        .iter()
        .map(|c| c.community_id.to_string())
        .collect();
    assert_eq!(actual, expected_order(&v["ranking"]["expectedOrder"]));
}

// ─── FIRA-P ─────────────────────────────────────────────────────────────────

fn people_options(v: &Value) -> fira_p::UserRecommendationOptions {
    fira_p::UserRecommendationOptions {
        weight_followers: f64_of(&v["weightFollowers"]),
        weight_social: f64_of(&v["weightSocial"]),
        weight_recency: f64_of(&v["weightRecency"]),
        recency_boost_days: i32_of(&v["recencyBoostDays"]),
        ..Default::default()
    }
}

fn people_candidate(v: &Value) -> fira_p::PeopleCandidate {
    fira_p::PeopleCandidate {
        user_uuid: uid(&v["userUuid"]),
        display_name: v["displayName"].as_str().expect("displayName").to_string(),
        follower_count: i32_of(&v["followerCount"]),
        followed_by_following_count: i32_of(&v["followedByFollowingCount"]),
        updated_at: utc(&v["updatedAt"]),
    }
}

#[test]
fn fira_p_scorer_matches_csharp() {
    let v = vector("fira-p-scorer-v1.json");
    let options = people_options(&v["options"]);
    let now = utc(&v["nowUtc"]);
    let tol = f64_of(&v["scoreToleranceRelative"]);

    for case in v["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().unwrap();
        assert_close(
            fira_p::score(&people_candidate(&case["candidate"]), &options, now),
            f64_of(&case["expectedScore"]),
            tol,
            &format!("{name}: score"),
        );
    }

    let candidates: Vec<fira_p::PeopleCandidate> = v["ranking"]["candidates"]
        .as_array()
        .expect("ranking.candidates")
        .iter()
        .map(people_candidate)
        .collect();
    let actual: Vec<String> = fira_p::rank(&candidates, &options, now)
        .iter()
        .map(|c| c.user_uuid.to_string())
        .collect();
    assert_eq!(actual, expected_order(&v["ranking"]["expectedOrder"]));
}

// ─── FIRA-M ─────────────────────────────────────────────────────────────────

fn music_options(v: &Value) -> fira_m::MusicRecommendationOptions {
    fira_m::MusicRecommendationOptions {
        weight_alpha: f64_of(&v["weightAlpha"]),
        weight_beta: f64_of(&v["weightBeta"]),
        weight_gamma: f64_of(&v["weightGamma"]),
        recency_boost_days: i32_of(&v["recencyBoostDays"]),
        exploration_quota: f64_of(&v["explorationQuota"]),
        max_candidates: i32_of(&v["maxCandidates"]),
        cache_ttl_seconds: i32_of(&v["cacheTtlSeconds"]),
    }
}

fn music_candidate(v: &Value) -> fira_m::MusicFlowCandidate {
    fira_m::MusicFlowCandidate {
        track_uuid: uid(&v["trackUuid"]),
        title: v["title"].as_str().expect("title").to_string(),
        genre_id: v["genreId"].as_str().map(str::to_string),
        published_at: utc(&v["publishedAt"]),
    }
}

#[test]
fn fira_m_scorer_matches_csharp() {
    let v = vector("fira-m-scorer-v1.json");
    let options = music_options(&v["options"]);
    let now = utc(&v["nowUtc"]);
    let tol = f64_of(&v["scoreToleranceRelative"]);

    // Дефолты кода нормативны: секции FiraMusic нет в appsettings.json (FIRA-M.md).
    assert_eq!(
        options,
        fira_m::MusicRecommendationOptions::default(),
        "вектор снят с дефолтов C# — дефолты Rust обязаны совпадать",
    );

    let genre_weights = fira_m::GenreWeights::from_pairs(
        v["genreWeights"]
            .as_object()
            .expect("genreWeights")
            .iter()
            .map(|(genre, weight)| (genre.as_str(), i32_of(weight))),
    );
    let max_genre_weight = genre_weights.max_weight();
    assert_eq!(
        i64::from(max_genre_weight),
        v["maxGenreWeight"].as_i64().unwrap()
    );

    for case in v["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().unwrap();
        assert_close(
            fira_m::score(
                &music_candidate(&case["track"]),
                &genre_weights,
                max_genre_weight,
                &options,
                now,
            ),
            f64_of(&case["expectedScore"]),
            tol,
            &format!("{name}: score"),
        );
    }

    let tracks: Vec<fira_m::MusicFlowCandidate> = v["ranking"]["tracks"]
        .as_array()
        .expect("ranking.tracks")
        .iter()
        .map(music_candidate)
        .collect();
    let actual: Vec<String> = fira_m::rank(&tracks, &genre_weights, &options, now)
        .iter()
        .map(|t| t.track_uuid.to_string())
        .collect();
    assert_eq!(actual, expected_order(&v["ranking"]["expectedOrder"]));
}
