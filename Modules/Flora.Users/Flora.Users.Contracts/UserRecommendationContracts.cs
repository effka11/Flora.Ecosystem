namespace Flora.Users.Contracts;

public sealed class RecommendedUserDto
{
    public Guid UserUuid { get; init; }
    public string DisplayName { get; init; } = "";
    public Guid? AvatarUuid { get; init; }
    public int FollowerCount { get; init; }
}

public interface IUserRecommendationService
{
    Task<IReadOnlyList<RecommendedUserDto>> GetRecommendedAsync(
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
    /// Инвалидировать кэш рекомендаций людей для пользователя.
    /// Вызывается при follow / unfollow (§13.2 FIRA.md — матрица триггеров FIRA-P).
    /// </summary>
    void InvalidateCache(Guid userUuid);
}

public sealed class UserRecommendationOptions
{
    public const string SectionName = "UserRecommendation";

    public double WeightFollowers { get; set; } = 2.0;
    public double WeightSocial    { get; set; } = 4.0;
    public double WeightRecency   { get; set; } = 1.0;
    public int    RecencyBoostDays { get; set; } = 30;

    /// <summary>TTL кэша рекомендаций людей, секунды (§13 FIRA.md: FIRA-P = 300 с).</summary>
    public int CacheTtlSeconds { get; set; } = 300;
}
