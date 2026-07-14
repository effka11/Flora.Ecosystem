//! FIRA-M — скорер «Music Flow», порт as-built v1. Первый переносимый FIRA-компонент (Фаза 1).
//!
//! Эталон (freeze до cutover Фазы 1, `docs/fira/FIRA.md` §15):
//! `Modules/Flora.Music/Flora.Music.Application/Recommendations/MusicFlowScorer.cs`;
//! сортировка — `MusicRecommendationService.GetOrComputeSnapshotAsync`.
//! Golden-вектор: `docs/test-vectors/fira/fira-m-scorer-v1.json`.
//!
//! Внимание: секции `FiraMusic` в `appsettings.json` **нет** — production работает на
//! дефолтах кода, поэтому `Default` ниже нормативен и обязан совпадать с C# бит-в-бит
//! (FIRA-M.md §Implementation Status, next-architecture.md §6 Фаза 1).

use chrono::{DateTime, Utc};
use flora_shared::dotnet_time::{ticks_between, total_days};
use flora_shared::ordinal::{cmp_ordinal_ignore_case, upper_invariant_key};
use std::collections::HashMap;
use uuid::Uuid;

/// Порт `MusicRecommendationOptions` (`Flora.Music.Contracts`, секция `FiraMusic`).
#[derive(Debug, Clone, PartialEq)]
pub struct MusicRecommendationOptions {
    pub weight_alpha: f64,
    pub weight_beta: f64,
    pub weight_gamma: f64,
    pub exploration_quota: f64,
    pub cache_ttl_seconds: i32,
    pub recency_boost_days: i32,
    pub max_candidates: i32,
}

impl MusicRecommendationOptions {
    pub const SECTION_NAME: &str = "FiraMusic";
}

impl Default for MusicRecommendationOptions {
    fn default() -> Self {
        Self {
            weight_alpha: 0.0,
            weight_beta: 0.75,
            weight_gamma: 0.25,
            exploration_quota: 0.15,
            cache_ttl_seconds: 180,
            recency_boost_days: 14,
            max_candidates: 500,
        }
    }
}

/// Скоринговое подмножество `MusicFlowCandidateRow` (C#): поля, влияющие на Score и tie-break.
/// Остальные поля выдачи (артисты, обложка, длительность) добавит HTTP-порт Фазы 1.
#[derive(Debug, Clone, PartialEq)]
pub struct MusicFlowCandidate {
    pub track_uuid: Uuid,
    pub title: String,
    pub genre_id: Option<String>,
    pub published_at: DateTime<Utc>,
}

/// Жанровые веса вкуса пользователя — аналог C#
/// `Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)`:
/// прокси вкуса `2 × свои треки + 1 × избранные` (строит репозиторий).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GenreWeights {
    by_upper_key: HashMap<String, i32>,
}

impl GenreWeights {
    pub fn from_pairs<I, S>(pairs: I) -> Self
    where
        I: IntoIterator<Item = (S, i32)>,
        S: AsRef<str>,
    {
        Self {
            by_upper_key: pairs
                .into_iter()
                .map(|(genre, weight)| (upper_invariant_key(genre.as_ref()), weight))
                .collect(),
        }
    }

    pub fn get(&self, genre_id: &str) -> Option<i32> {
        self.by_upper_key
            .get(&upper_invariant_key(genre_id))
            .copied()
    }

    /// `genreWeights.Values.DefaultIfEmpty(0).Max()` — максимум весов либо 0 для пустого словаря.
    pub fn max_weight(&self) -> i32 {
        self.by_upper_key.values().copied().max().unwrap_or(0)
    }
}

/// Score = WeightAlpha × 0.0 + WeightBeta × globalRelevance + WeightGamma × genreAffinity:
///   globalRelevance = max(0, RecencyBoostDays − releaseAgeDays) / RecencyBoostDays (линейный)
///   genreAffinity   = genreWeight(track.GenreId) / maxGenreWeight, иначе 0
/// Phase 0: α-слот намеренно 0 до появления listening-событий (v2).
pub fn score(
    track: &MusicFlowCandidate,
    genre_weights: &GenreWeights,
    max_genre_weight: i32,
    options: &MusicRecommendationOptions,
    now_utc: DateTime<Utc>,
) -> f64 {
    let recency_days = total_days(ticks_between(track.published_at, now_utc)).max(0.0);
    let recency_window = options.recency_boost_days.max(1);
    let global_relevance =
        0.0_f64.max(f64::from(recency_window) - recency_days) / f64::from(recency_window);

    // string.IsNullOrWhiteSpace + lookup в словаре с OrdinalIgnoreCase-ключами
    let genre_affinity = match track.genre_id.as_deref() {
        Some(genre) if !genre.trim().is_empty() && max_genre_weight > 0 => genre_weights
            .get(genre)
            .map_or(0.0, |w| f64::from(w) / f64::from(max_genre_weight)),
        _ => 0.0,
    };

    options.weight_alpha * 0.0
        + options.weight_beta * global_relevance
        + options.weight_gamma * genre_affinity
}

/// Нормативный tie-break FIRA-M (§15 FIRA.md):
/// `Score desc → PublishedAt desc → Title asc (ordinal, ignore case)`.
/// Сортировка стабильная — как LINQ в C#-сервисе.
pub fn rank(
    tracks: &[MusicFlowCandidate],
    genre_weights: &GenreWeights,
    options: &MusicRecommendationOptions,
    now_utc: DateTime<Utc>,
) -> Vec<MusicFlowCandidate> {
    let max_genre_weight = genre_weights.max_weight();
    let mut scored: Vec<(f64, MusicFlowCandidate)> = tracks
        .iter()
        .map(|t| {
            (
                score(t, genre_weights, max_genre_weight, options, now_utc),
                t.clone(),
            )
        })
        .collect();
    scored.sort_by(|a, b| {
        b.0.total_cmp(&a.0)
            .then_with(|| b.1.published_at.cmp(&a.1.published_at))
            .then_with(|| cmp_ordinal_ignore_case(&a.1.title, &b.1.title))
    });
    scored.into_iter().map(|(_, t)| t).collect()
}
