namespace Flora.Content.Contracts;

public sealed class RecommendedCommunityDto
{
    public Guid CommunityId { get; init; }
    public string Name { get; init; } = "";
    public string Slug { get; init; } = "";
    public int MemberCount { get; init; }
    public Guid? AvatarUuid { get; init; }
}

public interface ICommunityRecommendationService
{
    Task<IReadOnlyList<RecommendedCommunityDto>> GetRecommendedAsync(
        Guid userUuid,
        int take = 30,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// UTC-момент последнего вычисления набора. Null, если кэш пуст.
    /// </summary>
    DateTime? GetCacheGeneratedAt(Guid userUuid);

    /// <summary>
    /// UTC-момент истечения кэша (generatedAt + TTL). Null, если кэш пуст.
    /// Используется контроллером для поля expiresAt в ответе API (§13.3 FIRA.md) —
    /// чтобы не хардкодить TTL снаружи сервиса.
    /// </summary>
    DateTime? GetCacheExpiresAt(Guid userUuid);

    /// <summary>
    /// Инвалидировать кэш рекомендаций сообществ для пользователя.
    /// Вызывается при join / leave сообщества (§13.2 FIRA.md — матрица триггеров FIRA-C).
    /// </summary>
    void InvalidateCache(Guid userUuid);
}

public sealed class CommunityRecommendationOptions
{
    public const string SectionName = "CommunityRecommendation";

    public int    ActivityDays          { get; set; } = 14;
    public int    NewCommunityBoostDays { get; set; } = 14;
    public double WeightMembers         { get; set; } = 2.0;
    public double WeightActivity        { get; set; } = 3.0;
    public double WeightSocial          { get; set; } = 4.0;
    public double WeightRecency         { get; set; } = 1.5;

    /// <summary>TTL кэша рекомендаций сообществ, секунды (§13 FIRA.md: FIRA-C = 600 с).</summary>
    public int CacheTtlSeconds { get; set; } = 600;
}
