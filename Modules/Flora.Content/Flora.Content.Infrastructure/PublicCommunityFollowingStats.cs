using Flora.Users.Contracts;
using Microsoft.EntityFrameworkCore;

namespace Flora.Content.Infrastructure;

public sealed class PublicCommunityFollowingStats(ContentDbContext db) : IPublicCommunityFollowingStats
{
    public async Task<int> CountFollowingPublicCommunitiesExcludingOwnedAsync(
        Guid userUuid,
        IReadOnlyList<Guid> ownedCommunityIds,
        CancellationToken cancellationToken = default)
    {
        var publicIds = await db.Communities.AsNoTracking()
            .Where(c => !c.IsPrivate)
            .Select(c => c.CommunityId)
            .ToListAsync(cancellationToken);
        var showIds = publicIds.Except(ownedCommunityIds).ToHashSet();
        return await db.UserCommunities.AsNoTracking()
            .CountAsync(uc => uc.UserUuid == userUuid && showIds.Contains(uc.CommunityId), cancellationToken);
    }
}
