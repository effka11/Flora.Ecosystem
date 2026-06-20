namespace Flora.Content.Contracts;

public sealed class FeedPage
{
    public IReadOnlyList<Guid> PostUuids { get; init; } = Array.Empty<Guid>();
    public string? NextCursor { get; init; }
    public bool HasMore { get; init; }

    /// <summary>Момент вычисления / кэширования набора (§13.3 FIRA.md). Передаётся в has-new для поллинга.</summary>
    public DateTime GeneratedAt { get; init; } = DateTime.UtcNow;

    /// <summary>Время истечения TTL (GeneratedAt + CacheTtl). Клиент может автоматически рефрешнуть при now > ExpiresAt.</summary>
    public DateTime ExpiresAt { get; init; } = DateTime.UtcNow;
}

public interface IFeedRecommendationService
{
    Task<FeedPage> GetRecommendedFeedAsync(
        Guid userUuid,
        int take = 20,
        string? cursor = null,
        bool forceRefresh = false,
        CancellationToken cancellationToken = default);

    /// <summary>Хронологическая лента только от аккаунтов, на которые подписан пользователь (без алгоритма).</summary>
    Task<FeedPage> GetSubscriptionsFeedAsync(
        Guid userUuid,
        int take = 20,
        string? cursor = null,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Лёгкая проверка наличия нового контента в ленте (§13.4 FIRA.md).
    /// Возвращает true, если с момента <paramref name="since"/> появились новые посты от подписок пользователя.
    /// </summary>
    Task<bool> HasNewContentAsync(Guid userUuid, DateTime since, CancellationToken cancellationToken = default);

    void InvalidateFeedCache(Guid userUuid);
}

/// <summary>
/// FIRA-F configuration — Flora Individual Recommendation Algorithm (Feed component).
/// Соответствует спецификации docs/fira/FIRA-F.md v0.2, Phase 0 (без UIP-тем).
/// </summary>
public sealed class FiraFeedConfig
{
    public const string SectionName = "FiraFeed";

    // --- Веса фазы Phase 0 (cold start; нет UIP-тем — α=0) ---
    // α + β + γ = 1 (инвариант §3 FIRA.md)
    public double AlphaPhase0 { get; set; } = 0.0;
    public double BetaPhase0  { get; set; } = 0.70;
    public double GammaPhase0 { get; set; } = 0.30;

    // --- Затухание (§GlobalRelevance) ---
    // DecayLambda = 0.05 → полужизнь ≈ 14 ч для Standard-контента
    public double DecayLambda { get; set; } = 0.05;

    // --- Авторская аффинити (§IndividualAffinity) ---
    // tanh(rawScore / AffinityScale); первый лайк (+1.0) → tanh(0.2) ≈ 0.197
    public double AuthorAffinityScale { get; set; } = 5.0;

    // --- Правило тандема репоста (§Repost Signal) ---
    // Phase 0: AffinityThreshold = 0.0 — социальный сигнал один достаточен
    public double AffinityThreshold     { get; set; } = 0.0;
    public int    SocialRepostThreshold { get; set; } = 1;
    public double RepostWeight          { get; set; } = 1.5;
    public double RepostCap             { get; set; } = 3.0;

    // --- Разнообразие (§Постобработка) ---
    public int MaxConsecutiveSameAuthor { get; set; } = 2;

    // --- Квота исследования (15 % — discovery) ---
    public double ExplorationQuota { get; set; } = 0.15;

    // --- Пул кандидатов ---
    public int MaxCandidates          { get; set; } = 1000;
    public int FollowingWindowDays    { get; set; } = 7;
    public int TrendingWindowDays     { get; set; } = 2;
    public int InteractionHistoryDays { get; set; } = 90;

    // --- Кэш (TTL = 120 с по спецификации §Выдача) ---
    public bool EnableCache     { get; set; } = true;
    public int  CacheTtlSeconds { get; set; } = 120;

    // --- Явный refresh (pull-to-refresh / кнопка «Обновить») ---
    public int RefreshShuffleWindow { get; set; } = 5;
    public double[] RefreshPositionSwapProbabilities { get; set; } = [1.0, 0.75, 0.55, 0.35, 0.15];
    public int RefreshOwnPostProtectMinutes { get; set; } = 60;
}

/// <summary>Настройки для хронологической ленты «Подписки» (без алгоритма).</summary>
public sealed class FeedRecommendationOptions
{
    public const string SectionName = "FeedRecommendation";

    public bool EnableCache     { get; set; } = true;
    public int  CacheSeconds    { get; set; } = 120;
    public int  MaxCandidates   { get; set; } = 2000;
    public int  FollowingPostsDays { get; set; } = 30;
}
