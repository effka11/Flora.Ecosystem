using Flora.Content.Contracts;

namespace Flora.Content.Application.Feed;

/// <summary>
/// Реализация универсальной формулы скоринга FIRA-F (§3 FIRA.md, §Скоринг FIRA-F.md).
/// Все методы — чистые функции без побочных эффектов; тестируются изолированно.
///
/// Текущее состояние — Phase 0 (α = 0):
///   UIP-тематическая система не реализована, косинусная часть IndividualAffinity = 0.
///   Результирующая формула: Score = β·GlobalRelevance + γ·SocialProximity.
///   Как только тематические векторы постов появятся, α сдвинется в Phase 2 (0.45).
/// </summary>
internal static class FiraFeedScorer
{
    // §3 Универсальная формула скоринга
    // Score(post) = α·IndividualAffinity + β·GlobalRelevance + γ·SocialProximity
    public static double Score(FeedCandidate c, FiraFeedConfig cfg, DateTime nowUtc)
    {
        double ia = IndividualAffinity(c);
        double gr = GlobalRelevance(c, cfg, nowUtc);
        double sp = SocialProximity(c, ia, cfg);

        return cfg.AlphaPhase0 * ia
             + cfg.BetaPhase0  * gr
             + cfg.GammaPhase0 * sp;
    }

    // § IndividualAffinity
    // Полная формула: clamp01(cosine(postTopicVector, effectiveUip) × 0.7 + authorAffinity × 0.3)
    // Phase 0: постовые topic-векторы отсутствуют → cosine = 0
    // authorAffinity вычислен в сервисе: tanh(max(0, interactionScore) / affinityScale)
    public static double IndividualAffinity(FeedCandidate c) =>
        Math.Clamp(c.AuthorAffinity * 0.3, 0.0, 1.0);

    // § GlobalRelevance
    // GlobalRelevance = viral × exp(−λ × ageHours)
    // viral = engagementScore / ln(authorFollowers + 2)   — нормировка к размеру аудитории
    public static double GlobalRelevance(FeedCandidate c, FiraFeedConfig cfg, DateTime nowUtc)
    {
        var ageHours = Math.Max(0.0, (nowUtc - c.CreatedAt).TotalHours);
        var eng      = EngagementScore(c);
        // ln(authorFollowers + 2): при 0 подписчиков = ln(2) ≈ 0.693 (нет деления на 0)
        var viral    = eng / Math.Log(c.AuthorFollowerCount + 2);
        return viral * Math.Exp(-cfg.DecayLambda * ageHours);
    }

    // § SocialProximity
    // SocialProximity = ln(followedLikers + 1) × 3.0 + repostBoost
    public static double SocialProximity(FeedCandidate c, double ia, FiraFeedConfig cfg) =>
        Math.Log(c.FollowedLikersCount + 1) * 3.0 + RepostBoost(c, ia, cfg);

    // § Repost Signal — правило тандема
    // repostBoost = repostWeight × min(ln(repostedByFollowed + 1), repostCap)
    //             × heaviside(IndividualAffinity − affinityThreshold)
    // Phase 0: affinityThreshold = 0.0 → heaviside всегда 1 при любом ia ≥ 0
    public static double RepostBoost(FeedCandidate c, double ia, FiraFeedConfig cfg)
    {
        if (c.FollowedRepostersCount < cfg.SocialRepostThreshold) return 0.0;
        // heaviside(ia − threshold)
        if (ia < cfg.AffinityThreshold) return 0.0;
        return cfg.RepostWeight * Math.Min(Math.Log(c.FollowedRepostersCount + 1), cfg.RepostCap);
    }

    // § Engagement Score (§2.2 FIRA.md — веса сигналов)
    // Все счётчики — 48-часовые срезы (§Feature Extraction FIRA-F.md)
    private static double EngagementScore(FeedCandidate c) =>
          Math.Log(c.Likes48h     + 1) * 1.0
        + Math.Log(c.Comments48h  + 1) * 2.0
        + Math.Log(c.Reposts48h   + 1) * 2.5
        + Math.Log(c.Views48h     + 1) * 0.01;
}
