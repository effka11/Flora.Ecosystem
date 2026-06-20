using Flora.Users.Contracts;
using Microsoft.EntityFrameworkCore;

namespace Flora.Users.Infrastructure;

public sealed class FollowGraphReader(UsersDbContext db) : IFollowGraphReader
{
    public async Task<IReadOnlyList<Guid>> GetFollowingUserIdsAsync(Guid followerUserUuid, CancellationToken cancellationToken = default)
    {
        return await db.UserFollowers.AsNoTracking()
            .Where(f => f.FollowerUserUuid == followerUserUuid)
            .Select(f => f.FollowingUserUuid)
            .ToListAsync(cancellationToken);
    }

    public async Task<IReadOnlySet<Guid>> GetFollowingUserIdsForFollowersAsync(
        IReadOnlyCollection<Guid> followerUserUuids,
        Guid excludeUserUuid,
        CancellationToken cancellationToken = default)
    {
        if (followerUserUuids.Count == 0) return new HashSet<Guid>();
        var set = followerUserUuids as HashSet<Guid> ?? followerUserUuids.ToHashSet();
        var list = await db.UserFollowers.AsNoTracking()
            .Where(f => set.Contains(f.FollowerUserUuid) && f.FollowingUserUuid != excludeUserUuid)
            .Select(f => f.FollowingUserUuid)
            .Distinct()
            .ToListAsync(cancellationToken);
        return list.ToHashSet();
    }

    public Task<bool> IsFollowingAsync(Guid followerUserUuid, Guid followingUserUuid, CancellationToken cancellationToken = default) =>
        db.UserFollowers.AsNoTracking()
            .AnyAsync(f => f.FollowerUserUuid == followerUserUuid && f.FollowingUserUuid == followingUserUuid, cancellationToken);

    public async Task<bool> AreMutualFollowersAsync(Guid userA, Guid userB, CancellationToken cancellationToken = default)
    {
        if (userA == userB) return true;
        var links = await db.UserFollowers.AsNoTracking()
            .Where(f =>
                (f.FollowerUserUuid == userA && f.FollowingUserUuid == userB) ||
                (f.FollowerUserUuid == userB && f.FollowingUserUuid == userA))
            .Select(f => new { f.FollowerUserUuid, f.FollowingUserUuid })
            .ToListAsync(cancellationToken);
        var aFollowsB = links.Any(l => l.FollowerUserUuid == userA && l.FollowingUserUuid == userB);
        var bFollowsA = links.Any(l => l.FollowerUserUuid == userB && l.FollowingUserUuid == userA);
        return aFollowsB && bFollowsA;
    }

    public async Task<Dictionary<Guid, int>> GetFollowerCountsAsync(
        IReadOnlyCollection<Guid> userIds,
        CancellationToken cancellationToken = default)
    {
        if (userIds.Count == 0) return [];
        return await db.UserFollowers.AsNoTracking()
            .Where(f => userIds.Contains(f.FollowingUserUuid))
            .GroupBy(f => f.FollowingUserUuid)
            .Select(g => new { UserId = g.Key, Count = g.Count() })
            .ToDictionaryAsync(x => x.UserId, x => x.Count, cancellationToken);
    }
}
