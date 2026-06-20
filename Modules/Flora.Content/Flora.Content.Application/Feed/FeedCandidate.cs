namespace Flora.Content.Application.Feed;

/// <summary>
/// Обогащённый кандидат после шага Feature Extraction (§Шаг 2 FIRA-F).
/// Все данные, необходимые для вычисления IndividualAffinity, GlobalRelevance и SocialProximity.
/// </summary>
internal sealed record FeedCandidate(
    Guid   PostUuid,
    Guid   AuthorUserUuid,
    DateTime CreatedAt,

    // § GlobalRelevance — 48-часовые срезы (§Feature Extraction)
    int Likes48h,
    int Comments48h,
    int Reposts48h,
    int Views48h,

    // § GlobalRelevance — виральный коэффициент = engagementScore / ln(authorFollowers + 2)
    int AuthorFollowerCount,

    // § IndividualAffinity — tanh-нормированный накопленный сигнал взаимодействий с автором
    double AuthorAffinity,

    // § SocialProximity — сколько подписок лайкнуло пост
    int FollowedLikersCount,

    // § SocialProximity / Repost Signal — сколько подписок репостнуло пост
    int FollowedRepostersCount,

    // Начальный вес источника (не скоринговый; только для формирования пула)
    double PoolWeight
);
