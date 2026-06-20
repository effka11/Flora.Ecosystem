namespace Flora.Users.Contracts;

/// <summary>Port implemented by Content module: subscriptions to public communities excluding owned.</summary>
public interface IPublicCommunityFollowingStats
{
    Task<int> CountFollowingPublicCommunitiesExcludingOwnedAsync(
        Guid userUuid,
        IReadOnlyList<Guid> ownedCommunityIds,
        CancellationToken cancellationToken = default);
}
