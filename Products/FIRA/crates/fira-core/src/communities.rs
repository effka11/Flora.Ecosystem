//! FIRA-C — скорер рекомендаций сообществ, порт as-built v1.
//!
//! Эталон (freeze до cutover Фазы 3, `docs/fira/FIRA.md` §15):
//! `Modules/Flora.Content/Flora.Content.Application/Communities/CommunityRecommendationScorer.cs`;
//! сортировка — `CommunityRecommendationService.GetOrComputeSnapshotAsync`.
//! Golden-вектор: `docs/test-vectors/fira/fira-c-scorer-v1.json`.

use chrono::{DateTime, Utc};
use flora_shared::dotnet_time::{ticks_between, total_days};
use flora_shared::ordinal::cmp_ordinal_ignore_case;
use uuid::Uuid;

/// Порт `CommunityRecommendationOptions` (`Flora.Content.Contracts`, секция `CommunityRecommendation`).
/// Секция в `appsettings.json` полная и совпадает с этими дефолтами (FIRA-C.md §Implementation Status).
#[derive(Debug, Clone, PartialEq)]
pub struct CommunityRecommendationOptions {
    pub activity_days: i32,
    pub new_community_boost_days: i32,
    pub weight_members: f64,
    pub weight_activity: f64,
    pub weight_social: f64,
    pub weight_recency: f64,
    pub cache_ttl_seconds: i32,
}

impl CommunityRecommendationOptions {
    pub const SECTION_NAME: &str = "CommunityRecommendation";
}

impl Default for CommunityRecommendationOptions {
    fn default() -> Self {
        Self {
            activity_days: 14,
            new_community_boost_days: 14,
            weight_members: 2.0,
            weight_activity: 3.0,
            weight_social: 4.0,
            weight_recency: 1.5,
            cache_ttl_seconds: 600,
        }
    }
}

/// Скоринговое подмножество `CommunityRecommendationCandidate` (C#).
/// Поля выдачи (slug, avatar) добавит HTTP-порт Фазы 3 — на скоринг они не влияют.
#[derive(Debug, Clone, PartialEq)]
pub struct CommunityCandidate {
    pub community_id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub member_count: i32,
    pub recent_post_count: i32,
    pub followed_members_count: i32,
}

/// Score = memberScore + activityScore + socialScore + recencyScore:
///   memberScore   = log10(max(memberCount, 0) + 1)      × WeightMembers
///   activityScore = log10(max(recentPostCount, 0) + 1)  × WeightActivity
///   socialScore   = log10(max(followedMembers, 0) + 1)  × WeightSocial
///   recencyScore  = max(0, BoostDays − ageDays) / BoostDays × WeightRecency
pub fn score(
    candidate: &CommunityCandidate,
    options: &CommunityRecommendationOptions,
    now_utc: DateTime<Utc>,
) -> f64 {
    let member_score =
        f64::from(candidate.member_count.max(0) + 1).log10() * options.weight_members;
    let activity_score =
        f64::from(candidate.recent_post_count.max(0) + 1).log10() * options.weight_activity;
    let social_score =
        f64::from(candidate.followed_members_count.max(0) + 1).log10() * options.weight_social;

    let age_days = total_days(ticks_between(candidate.created_at, now_utc)).max(0.0);
    let boost_window = options.new_community_boost_days.max(1);
    let recency_score = 0.0_f64.max(f64::from(boost_window) - age_days) / f64::from(boost_window)
        * options.weight_recency;

    member_score + activity_score + social_score + recency_score
}

/// Нормативный tie-break FIRA-C (§15 FIRA.md): `Score desc → Name asc (ordinal, ignore case)`.
/// Сортировка стабильная — как LINQ `OrderByDescending…ThenBy` в C#-сервисе: при полном
/// совпадении score и имени сохраняется исходный порядок кандидатов.
pub fn rank(
    candidates: &[CommunityCandidate],
    options: &CommunityRecommendationOptions,
    now_utc: DateTime<Utc>,
) -> Vec<CommunityCandidate> {
    let mut scored: Vec<(f64, CommunityCandidate)> = candidates
        .iter()
        .map(|c| (score(c, options, now_utc), c.clone()))
        .collect();
    scored.sort_by(|a, b| {
        b.0.total_cmp(&a.0)
            .then_with(|| cmp_ordinal_ignore_case(&a.1.name, &b.1.name))
    });
    scored.into_iter().map(|(_, c)| c).collect()
}
