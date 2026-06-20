namespace Flora.Users.Contracts;

public interface IFollowGraphReader
{
    Task<IReadOnlyList<Guid>> GetFollowingUserIdsAsync(Guid followerUserUuid, CancellationToken cancellationToken = default);

    /// <summary>Distinct users followed by anyone in <paramref name="followerUserUuids"/>, excluding <paramref name="excludeUserUuid"/>.</summary>
    Task<IReadOnlySet<Guid>> GetFollowingUserIdsForFollowersAsync(
        IReadOnlyCollection<Guid> followerUserUuids,
        Guid excludeUserUuid,
        CancellationToken cancellationToken = default);

    Task<bool> IsFollowingAsync(Guid followerUserUuid, Guid followingUserUuid, CancellationToken cancellationToken = default);

    /// <summary>Взаимная подписка (оба follow друг друга).</summary>
    Task<bool> AreMutualFollowersAsync(Guid userA, Guid userB, CancellationToken cancellationToken = default);

    /// <summary>
    /// Количество подписчиков для каждого из переданных пользователей.
    /// Используется FIRA-F для нормировки виральности: viral = engagementScore / ln(authorFollowers + 2).
    /// Авторы без подписчиков отсутствуют в результирующем словаре (считать = 0).
    /// </summary>
    Task<Dictionary<Guid, int>> GetFollowerCountsAsync(
        IReadOnlyCollection<Guid> userIds,
        CancellationToken cancellationToken = default);
}
