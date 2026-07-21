//! FIRA-F — скорер и постобработка ленты, порт as-built v1 (Phase 0, α = 0).
//!
//! Эталон (freeze до cutover Фазы 3, `Documents/fira/FIRA.md` §15, §17):
//! - `Modules/Flora.Content/Flora.Content.Application/Feed/FiraFeedScorer.cs`
//! - `Modules/Flora.Content/Flora.Content.Application/Feed/FiraFeedPostProcessing.cs`
//!
//! Числовой паритет доказывается golden-векторами `Documents/test-vectors/fira/fira-f-scorer-v1.json`
//! и `fira-f-postprocessing-v1.json` (Rust-потребитель — `Backend/Tests/parity/tests/fira_vectors.rs`).
//! Трансцендентные функции (ln/exp/tanh) сверяются с относительным допуском 1e-12;
//! порядок ранжирования и позиционная постобработка — точно.

use chrono::{DateTime, Utc};
use fira_contracts::{AuthorDiversity, ExplorationLevel, FeedFreshness, FeedPreferences};
use flora_shared::dotnet_time::{ticks_between, total_hours};
use uuid::Uuid;

/// Конфиг FIRA-F — порт `FiraFeedConfig` (`Flora.Content.Contracts`, секция `FiraFeed`).
///
/// `Default` обязан бит-в-бит совпадать с дефолтами C#: ключи, отсутствующие в
/// `appsettings.json` (refresh-группа — см. FIRA-F.md §Implementation Status),
/// в production берутся именно из этих значений.
#[derive(Debug, Clone, PartialEq)]
pub struct FiraFeedConfig {
    // Веса Phase 0 (α + β + γ = 1, инвариант §3 FIRA.md)
    pub alpha_phase0: f64,
    pub beta_phase0: f64,
    pub gamma_phase0: f64,

    // Затухание §GlobalRelevance: λ = 0.05 → полужизнь ≈ 14 ч
    pub decay_lambda: f64,

    // §IndividualAffinity: authorAffinity = tanh(raw / scale)
    pub author_affinity_scale: f64,

    // §Repost Signal — правило тандема
    pub affinity_threshold: f64,
    pub social_repost_threshold: i32,
    pub repost_weight: f64,
    pub repost_cap: f64,

    // §Постобработка
    pub max_consecutive_same_author: i32,
    pub exploration_quota: f64,

    // Пул кандидатов
    pub max_candidates: i32,
    pub min_feed_size: i32,
    pub following_window_days: i32,
    pub trending_window_days: i32,
    pub interaction_history_days: i32,

    // Кэш
    pub enable_cache: bool,
    pub cache_ttl_seconds: i32,

    // Явный refresh (ключи отсутствуют в appsettings.json — действуют эти дефолты)
    pub refresh_shuffle_window: i32,
    pub refresh_position_swap_probabilities: Vec<f64>,
    pub refresh_own_post_protect_minutes: i32,

    // §User Controls (v1.1): негативный фидбек и просмотренные.
    // Нейтральные входы кандидата (seen=false, count=0) дают бит-в-бит прежний Score.
    /// Множитель Score для просмотренного поста в режиме `SeenPostsMode::Demote`.
    pub seen_demotion_factor: f64,
    /// Множитель Score за каждую отметку «не интересно» по постам автора (степень).
    pub not_interested_author_penalty: f64,
    /// Максимум учитываемых отметок «не интересно» по автору (ограничение степени).
    pub not_interested_author_cap: i32,
}

impl FiraFeedConfig {
    pub const SECTION_NAME: &str = "FiraFeed";
}

impl Default for FiraFeedConfig {
    fn default() -> Self {
        Self {
            alpha_phase0: 0.0,
            beta_phase0: 0.70,
            gamma_phase0: 0.30,
            decay_lambda: 0.05,
            author_affinity_scale: 5.0,
            affinity_threshold: 0.0,
            social_repost_threshold: 1,
            repost_weight: 1.5,
            repost_cap: 3.0,
            max_consecutive_same_author: 2,
            exploration_quota: 0.15,
            max_candidates: 1000,
            min_feed_size: 20,
            following_window_days: 7,
            trending_window_days: 2,
            interaction_history_days: 90,
            enable_cache: true,
            cache_ttl_seconds: 120,
            refresh_shuffle_window: 5,
            refresh_position_swap_probabilities: vec![1.0, 0.75, 0.55, 0.35, 0.15],
            refresh_own_post_protect_minutes: 60,
            seen_demotion_factor: 0.3,
            not_interested_author_penalty: 0.5,
            not_interested_author_cap: 3,
        }
    }
}

// §User Controls: нормативное отображение FeedPreferences → FiraFeedConfig
// (FIRA-F.md §User Controls). Значения Balanced/Standard обязаны совпадать с Default.
const FRESHNESS_LAMBDA_FRESH: f64 = 0.10;
const FRESHNESS_LAMBDA_BALANCED: f64 = 0.05;
const FRESHNESS_LAMBDA_POPULAR: f64 = 0.025;
const EXPLORATION_QUOTA_OFF: f64 = 0.0;
const EXPLORATION_QUOTA_LOW: f64 = 0.08;
const EXPLORATION_QUOTA_STANDARD: f64 = 0.15;
const EXPLORATION_QUOTA_HIGH: f64 = 0.25;

/// Применяет пользовательские настройки ленты к конфигу FIRA-F.
/// Детерминированное отображение; `FeedPreferences::default()` с `seen_posts = Show`
/// оставляет конфиг без изменений (паритет v1).
pub fn apply_preferences(cfg: &mut FiraFeedConfig, prefs: &FeedPreferences) {
    cfg.decay_lambda = match prefs.freshness {
        FeedFreshness::Fresh => FRESHNESS_LAMBDA_FRESH,
        FeedFreshness::Balanced => FRESHNESS_LAMBDA_BALANCED,
        FeedFreshness::Popular => FRESHNESS_LAMBDA_POPULAR,
    };
    cfg.exploration_quota = match prefs.exploration {
        ExplorationLevel::Off => EXPLORATION_QUOTA_OFF,
        ExplorationLevel::Low => EXPLORATION_QUOTA_LOW,
        ExplorationLevel::Standard => EXPLORATION_QUOTA_STANDARD,
        ExplorationLevel::High => EXPLORATION_QUOTA_HIGH,
    };
    if !prefs.show_reposts {
        // Репостный буст выключен; исключение репостного пула — на стороне Social.
        cfg.repost_weight = 0.0;
    }
    cfg.max_consecutive_same_author = match prefs.author_diversity {
        AuthorDiversity::Strict => 1,
        AuthorDiversity::Standard => 2,
        AuthorDiversity::Off => i32::MAX,
    };
}

/// Обогащённый кандидат после Feature Extraction — порт `FeedCandidate` (C#).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FeedCandidate {
    pub post_uuid: Uuid,
    pub author_user_uuid: Uuid,
    pub created_at: DateTime<Utc>,

    // §GlobalRelevance — 48-часовые срезы
    pub likes_48h: i32,
    pub comments_48h: i32,
    pub reposts_48h: i32,
    pub views_48h: i32,

    // §GlobalRelevance — виральный коэффициент = engagementScore / ln(authorFollowers + 2)
    pub author_follower_count: i32,

    // §IndividualAffinity — tanh-нормированный накопленный сигнал взаимодействий с автором
    pub author_affinity: f64,

    // §SocialProximity
    pub followed_likers_count: i32,
    pub followed_reposters_count: i32,

    /// Начальный вес источника (не скоринговый; только для формирования пула).
    pub pool_weight: f64,

    // §User Controls (v1.1). Нейтральные значения (false / 0) сохраняют паритет v1.
    /// Пост уже просмотрен пользователем (режим `SeenPostsMode::Demote`).
    pub seen: bool,
    /// Число отметок «не интересно» по постам этого автора (окно interaction_history_days).
    pub author_not_interested_count: i32,
}

/// §3 FIRA.md: Score = α·IndividualAffinity + β·GlobalRelevance + γ·SocialProximity,
/// затем множители §User Controls (v1.1): демоция просмотренных и штраф «не интересно».
/// Нейтральные входы (seen=false, count=0) не изменяют Score (ветвление, не умножение на 1).
pub fn score(c: &FeedCandidate, cfg: &FiraFeedConfig, now_utc: DateTime<Utc>) -> f64 {
    let ia = individual_affinity(c);
    let gr = global_relevance(c, cfg, now_utc);
    let sp = social_proximity(c, ia, cfg);

    let mut score = cfg.alpha_phase0 * ia + cfg.beta_phase0 * gr + cfg.gamma_phase0 * sp;
    if c.seen {
        score *= cfg.seen_demotion_factor;
    }
    let penalty_hits = c
        .author_not_interested_count
        .min(cfg.not_interested_author_cap);
    if penalty_hits > 0 {
        score *= cfg.not_interested_author_penalty.powi(penalty_hits);
    }
    score
}

/// authorAffinity = tanh(max(0, rawInteractionScore) / affinityScale) — §IndividualAffinity FIRA-F.md.
pub fn author_affinity(raw_interaction_score: f64, affinity_scale: f64) -> f64 {
    (raw_interaction_score.max(0.0) / affinity_scale).tanh()
}

/// §IndividualAffinity, Phase 0: постовых topic-векторов нет → косинусная часть = 0,
/// остаётся clamp01(authorAffinity × 0.3).
pub fn individual_affinity(c: &FeedCandidate) -> f64 {
    (c.author_affinity * 0.3).clamp(0.0, 1.0)
}

/// §GlobalRelevance: viral × exp(−λ × ageHours), viral = engagement / ln(followers + 2).
pub fn global_relevance(c: &FeedCandidate, cfg: &FiraFeedConfig, now_utc: DateTime<Utc>) -> f64 {
    let age_hours = 0.0_f64.max(total_hours(ticks_between(c.created_at, now_utc)));
    let eng = engagement_score(c);
    // ln(authorFollowers + 2): при 0 подписчиков = ln(2) ≈ 0.693 (нет деления на 0)
    let viral = eng / f64::from(c.author_follower_count + 2).ln();
    viral * (-cfg.decay_lambda * age_hours).exp()
}

/// §SocialProximity: ln(followedLikers + 1) × 3.0 + repostBoost.
pub fn social_proximity(c: &FeedCandidate, ia: f64, cfg: &FiraFeedConfig) -> f64 {
    f64::from(c.followed_likers_count + 1).ln() * 3.0 + repost_boost(c, ia, cfg)
}

/// §Repost Signal — правило тандема:
/// repostBoost = repostWeight × min(ln(repostedByFollowed + 1), repostCap)
///             × heaviside(IndividualAffinity − affinityThreshold).
pub fn repost_boost(c: &FeedCandidate, ia: f64, cfg: &FiraFeedConfig) -> f64 {
    if c.followed_reposters_count < cfg.social_repost_threshold {
        return 0.0;
    }
    // heaviside(ia − threshold); Phase 0: threshold = 0.0 → всегда 1 при ia ≥ 0
    if ia < cfg.affinity_threshold {
        return 0.0;
    }
    cfg.repost_weight
        * f64::from(c.followed_reposters_count + 1)
            .ln()
            .min(cfg.repost_cap)
}

/// §2.2 FIRA.md — веса сигналов; все счётчики — 48-часовые срезы.
fn engagement_score(c: &FeedCandidate) -> f64 {
    f64::from(c.likes_48h + 1).ln() * 1.0
        + f64::from(c.comments_48h + 1).ln() * 2.0
        + f64::from(c.reposts_48h + 1).ln() * 2.5
        + f64::from(c.views_48h + 1).ln() * 0.01
}

/// Ранжирование пула с нормативным tie-break (§15 FIRA.md):
/// `Score desc → CreatedAt desc → PostUuid asc`. Единственная точка сортировки FIRA-F.
///
/// Паритет сравнения UUID: `uuid::Uuid::cmp` сравнивает RFC-байты лексикографически —
/// эквивалент `Guid.CompareTo` (.NET сравнивает поля как беззнаковые в big-endian порядке).
/// `total_cmp` для score эквивалентен сравнению .NET: NaN в домене не возникает
/// (ln аргументов ≥ 1, exp/tanh конечны), −0.0 не производится (суммы неотрицательных произведений).
pub fn rank(
    candidates: &[FeedCandidate],
    cfg: &FiraFeedConfig,
    now_utc: DateTime<Utc>,
) -> Vec<FeedCandidate> {
    let mut scored: Vec<(f64, FeedCandidate)> = candidates
        .iter()
        .map(|c| (score(c, cfg, now_utc), *c))
        .collect();
    scored.sort_by(|a, b| {
        b.0.total_cmp(&a.0)
            .then_with(|| b.1.created_at.cmp(&a.1.created_at))
            .then_with(|| a.1.post_uuid.cmp(&b.1.post_uuid))
    });
    scored.into_iter().map(|(_, c)| c).collect()
}

/// Гарантирует, что автор не занимает более `max_consecutive` позиций подряд
/// (§Шаг 4 FIRA-F.md). Первый проход вытесняет лишние посты; второй дописывает
/// вытесненные, продолжая соблюдать лимит серий; неизбежные серии — в конце.
pub fn apply_author_diversity(
    sorted: &[FeedCandidate],
    max_consecutive: i32,
) -> Vec<FeedCandidate> {
    let mut result: Vec<FeedCandidate> = Vec::with_capacity(sorted.len());
    let mut deferred: Vec<FeedCandidate> = Vec::new();
    let mut streak: i32 = 0;
    let mut last_author: Option<Uuid> = None;

    for c in sorted {
        if Some(c.author_user_uuid) == last_author {
            if streak >= max_consecutive {
                deferred.push(*c);
                continue;
            }
            streak += 1;
        } else {
            last_author = Some(c.author_user_uuid);
            streak = 1;
        }
        result.push(*c);
    }

    // Второй проход: среди допустимых берётся первый по исходному рангу.
    while !deferred.is_empty() {
        let pick = deferred
            .iter()
            .position(|d| !would_exceed_tail_streak(&result, d.author_user_uuid, max_consecutive))
            .unwrap_or(0); // остались посты одного автора — серия неизбежна
        result.push(deferred.remove(pick));
    }

    result
}

fn would_exceed_tail_streak(result: &[FeedCandidate], author: Uuid, max_consecutive: i32) -> bool {
    let streak = result
        .iter()
        .rev()
        .take_while(|c| c.author_user_uuid == author)
        .count();
    streak >= max_consecutive.max(0) as usize
}

/// Равномерно перемежает exploration-посты с основным списком (§Шаг 4 FIRA-F.md):
/// 1 exploration после каждых `period = round(1/ε − 1)` основных → доля 1/(period+1);
/// при ε = 0.15 → period = 6 → 1/7 ≈ 14.3 %. Остаток exploration — в хвост.
pub fn interleave_exploration(
    main: Vec<Uuid>,
    exploration: &[Uuid],
    exploration_quota: f64,
) -> Vec<Uuid> {
    if exploration.is_empty() {
        return main;
    }

    let period = exploration_period(exploration_quota);
    let mut result: Vec<Uuid> = Vec::with_capacity(main.len() + exploration.len());
    let mut expl_idx: usize = 0;

    for (i, id) in main.iter().enumerate() {
        result.push(*id);
        if (i + 1) % period == 0 && expl_idx < exploration.len() {
            result.push(exploration[expl_idx]);
            expl_idx += 1;
        }
    }
    result.extend_from_slice(&exploration[expl_idx..]);

    result
}

/// period = max(1, round(1/ε − 1)); округление к чётному — `Math.Round(…, MidpointRounding.ToEven)`
/// в C# и `f64::round_ties_even` в Rust дают одинаковый результат.
pub fn exploration_period(exploration_quota: f64) -> usize {
    let period = (1.0 / exploration_quota.max(0.01) - 1.0).round_ties_even() as i64;
    period.max(1) as usize
}

#[cfg(test)]
mod tests {
    use super::*;
    use fira_contracts::SeenPostsMode;

    fn candidate() -> FeedCandidate {
        FeedCandidate {
            post_uuid: Uuid::from_u128(1),
            author_user_uuid: Uuid::from_u128(2),
            created_at: DateTime::parse_from_rfc3339("2026-07-01T12:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
            likes_48h: 10,
            comments_48h: 4,
            reposts_48h: 2,
            views_48h: 300,
            author_follower_count: 50,
            author_affinity: 0.8,
            followed_likers_count: 3,
            followed_reposters_count: 1,
            pool_weight: 1.0,
            seen: false,
            author_not_interested_count: 0,
        }
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-07-01T18:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn neutral_inputs_keep_v1_score_bit_for_bit() {
        // seen=false, count=0 — путь скоринга не должен домножать Score.
        let cfg = FiraFeedConfig::default();
        let c = candidate();
        let ia = individual_affinity(&c);
        let expected = cfg.alpha_phase0 * ia
            + cfg.beta_phase0 * global_relevance(&c, &cfg, now())
            + cfg.gamma_phase0 * social_proximity(&c, ia, &cfg);
        assert_eq!(score(&c, &cfg, now()), expected);
    }

    #[test]
    fn seen_demotion_multiplies_score() {
        let cfg = FiraFeedConfig::default();
        let base = score(&candidate(), &cfg, now());
        let seen = FeedCandidate {
            seen: true,
            ..candidate()
        };
        assert_eq!(score(&seen, &cfg, now()), base * cfg.seen_demotion_factor);
    }

    #[test]
    fn not_interested_penalty_is_capped_power() {
        let cfg = FiraFeedConfig::default();
        let base = score(&candidate(), &cfg, now());

        let one = FeedCandidate {
            author_not_interested_count: 1,
            ..candidate()
        };
        assert_eq!(
            score(&one, &cfg, now()),
            base * cfg.not_interested_author_penalty
        );

        let over_cap = FeedCandidate {
            author_not_interested_count: 100,
            ..candidate()
        };
        assert_eq!(
            score(&over_cap, &cfg, now()),
            base * cfg
                .not_interested_author_penalty
                .powi(cfg.not_interested_author_cap)
        );
    }

    #[test]
    fn penalty_and_demotion_do_not_break_rank_tie_break() {
        // Наказанный кандидат опускается ниже нейтрального с тем же базовым Score.
        let cfg = FiraFeedConfig::default();
        let neutral = candidate();
        let penalized = FeedCandidate {
            post_uuid: Uuid::from_u128(9),
            author_user_uuid: Uuid::from_u128(10),
            author_not_interested_count: 2,
            ..candidate()
        };
        let ranked = rank(&[penalized, neutral], &cfg, now());
        assert_eq!(ranked[0].post_uuid, Uuid::from_u128(1));
        assert_eq!(ranked[1].post_uuid, Uuid::from_u128(9));
    }

    #[test]
    fn balanced_standard_preferences_keep_default_config() {
        // Balanced/Standard/показывать всё = конфиг v1 (кроме продуктового дефолта seen=Demote,
        // который в конфиг не входит — обрабатывается кандидатами).
        let mut cfg = FiraFeedConfig::default();
        let prefs = FeedPreferences {
            seen_posts: SeenPostsMode::Show,
            ..FeedPreferences::default()
        };
        apply_preferences(&mut cfg, &prefs);
        assert_eq!(cfg, FiraFeedConfig::default());
    }

    #[test]
    fn preferences_map_to_documented_constants() {
        let mut cfg = FiraFeedConfig::default();
        apply_preferences(
            &mut cfg,
            &FeedPreferences {
                freshness: FeedFreshness::Fresh,
                exploration: ExplorationLevel::High,
                show_reposts: false,
                community_posts: false,
                seen_posts: SeenPostsMode::Hide,
                author_diversity: AuthorDiversity::Strict,
            },
        );
        assert_eq!(cfg.decay_lambda, 0.10);
        assert_eq!(cfg.exploration_quota, 0.25);
        assert_eq!(cfg.repost_weight, 0.0);
        assert_eq!(cfg.max_consecutive_same_author, 1);

        let mut cfg2 = FiraFeedConfig::default();
        apply_preferences(
            &mut cfg2,
            &FeedPreferences {
                freshness: FeedFreshness::Popular,
                exploration: ExplorationLevel::Off,
                author_diversity: AuthorDiversity::Off,
                ..FeedPreferences::default()
            },
        );
        assert_eq!(cfg2.decay_lambda, 0.025);
        assert_eq!(cfg2.exploration_quota, 0.0);
        assert_eq!(cfg2.max_consecutive_same_author, i32::MAX);
        // show_reposts=true не трогает репостный вес.
        assert_eq!(cfg2.repost_weight, FiraFeedConfig::default().repost_weight);
    }

    #[test]
    fn author_diversity_off_keeps_order() {
        let a = Uuid::from_u128(1);
        let mk = |id: u128| FeedCandidate {
            post_uuid: Uuid::from_u128(id),
            author_user_uuid: a,
            ..candidate()
        };
        let items = [mk(1), mk(2), mk(3), mk(4)];
        let out = apply_author_diversity(&items, i32::MAX);
        let ids: Vec<Uuid> = out.iter().map(|c| c.post_uuid).collect();
        assert_eq!(
            ids,
            vec![
                Uuid::from_u128(1),
                Uuid::from_u128(2),
                Uuid::from_u128(3),
                Uuid::from_u128(4)
            ]
        );
    }
}
