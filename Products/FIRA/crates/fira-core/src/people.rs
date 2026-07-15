//! FIRA-P — скорер рекомендаций людей, порт as-built v1.
//!
//! Эталон (freeze до cutover Фазы 2b, `Documents/fira/FIRA.md` §15):
//! `Modules/Flora.Users/Flora.Users.Application/People/UserRecommendationScorer.cs`;
//! сортировка — `UserRecommendationService.GetOrComputeSnapshotAsync`.
//! Golden-вектор: `Documents/test-vectors/fira/fira-p-scorer-v1.json` — снят **после**
//! v1.1-гигиены (блоклист в кандидатном пуле), дефект через freeze не протянут (§17 FIRA.md).

use chrono::{DateTime, Utc};
use flora_shared::dotnet_time::{ticks_between, total_days};
use flora_shared::ordinal::cmp_ordinal_ignore_case;
use uuid::Uuid;

/// Порт `UserRecommendationOptions` (`Flora.Users.Contracts`, секция `UserRecommendation`).
/// Секция в `appsettings.json` полная и совпадает с этими дефолтами (FIRA-P.md §Implementation Status).
#[derive(Debug, Clone, PartialEq)]
pub struct UserRecommendationOptions {
    pub weight_followers: f64,
    pub weight_social: f64,
    pub weight_recency: f64,
    pub recency_boost_days: i32,
    pub cache_ttl_seconds: i32,
}

impl UserRecommendationOptions {
    pub const SECTION_NAME: &str = "UserRecommendation";
}

impl Default for UserRecommendationOptions {
    fn default() -> Self {
        Self {
            weight_followers: 2.0,
            weight_social: 4.0,
            weight_recency: 1.0,
            recency_boost_days: 30,
            cache_ttl_seconds: 300,
        }
    }
}

/// Скоринговое подмножество `UserRecommendationCandidate` (C#).
/// Поле выдачи (avatar) добавит HTTP-порт Фазы 2b — на скоринг оно не влияет.
#[derive(Debug, Clone, PartialEq)]
pub struct PeopleCandidate {
    pub user_uuid: Uuid,
    pub display_name: String,
    pub follower_count: i32,
    pub followed_by_following_count: i32,
    /// Недавняя активность профиля (не дата регистрации).
    pub updated_at: DateTime<Utc>,
}

/// Score = followerScore + socialScore + recencyScore:
///   followerScore = log10(max(followerCount, 0) + 1)       × WeightFollowers
///   socialScore   = log10(max(followedByFollowing, 0) + 1) × WeightSocial
///   recencyScore  = max(0, BoostDays − ageDays) / BoostDays × WeightRecency
pub fn score(
    candidate: &PeopleCandidate,
    options: &UserRecommendationOptions,
    now_utc: DateTime<Utc>,
) -> f64 {
    let follower_score =
        f64::from(candidate.follower_count.max(0) + 1).log10() * options.weight_followers;
    let social_score =
        f64::from(candidate.followed_by_following_count.max(0) + 1).log10() * options.weight_social;

    let age_days = total_days(ticks_between(candidate.updated_at, now_utc)).max(0.0);
    let boost_window = options.recency_boost_days.max(1);
    let recency_score = 0.0_f64.max(f64::from(boost_window) - age_days) / f64::from(boost_window)
        * options.weight_recency;

    follower_score + social_score + recency_score
}

/// Нормативный tie-break FIRA-P (§15 FIRA.md): `Score desc → DisplayName asc (ordinal, ignore case)`.
/// Сортировка стабильная — как LINQ в C#-сервисе: при полном совпадении score и имени
/// сохраняется исходный порядок кандидатов.
pub fn rank(
    candidates: &[PeopleCandidate],
    options: &UserRecommendationOptions,
    now_utc: DateTime<Utc>,
) -> Vec<PeopleCandidate> {
    let mut scored: Vec<(f64, PeopleCandidate)> = candidates
        .iter()
        .map(|c| (score(c, options, now_utc), c.clone()))
        .collect();
    scored.sort_by(|a, b| {
        b.0.total_cmp(&a.0)
            .then_with(|| cmp_ordinal_ignore_case(&a.1.display_name, &b.1.display_name))
    });
    scored.into_iter().map(|(_, c)| c).collect()
}
