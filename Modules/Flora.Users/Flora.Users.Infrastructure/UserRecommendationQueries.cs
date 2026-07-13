using Flora.Users.Application.People;
using Microsoft.EntityFrameworkCore;

namespace Flora.Users.Infrastructure;

public sealed class UserRecommendationQueries(UsersDbContext db) : IUserRecommendationQueries
{
    public async Task<IReadOnlyList<UserRecommendationCandidate>> GetCandidatesAsync(
        Guid userUuid,
        IReadOnlyCollection<Guid> followingUserIds,
        CancellationToken cancellationToken = default)
    {
        var excluded = followingUserIds.ToHashSet();
        excluded.Add(userUuid);

        // Инвариант §12 FIRA.md (v1.1, критично): блокировка в любом направлении
        // исключает кандидата из пула — она не «понижает», а исключает.
        var blocked = await db.UserBlocks.AsNoTracking()
            .Where(b => b.OwnerUserUuid == userUuid || b.BlockedUserUuid == userUuid)
            .Select(b => b.OwnerUserUuid == userUuid ? b.BlockedUserUuid : b.OwnerUserUuid)
            .ToListAsync(cancellationToken);
        excluded.UnionWith(blocked);

        var profiles = await db.UserProfiles.AsNoTracking()
            .Where(p => !excluded.Contains(p.UserUuid))
            .ToListAsync(cancellationToken);

        if (profiles.Count == 0)
            return Array.Empty<UserRecommendationCandidate>();

        var userIds = profiles.Select(p => p.UserUuid).ToList();

        var followerCounts = await db.UserFollowers.AsNoTracking()
            .Where(f => userIds.Contains(f.FollowingUserUuid))
            .GroupBy(f => f.FollowingUserUuid)
            .Select(g => new { UserUuid = g.Key, Count = g.Count() })
            .ToListAsync(cancellationToken);
        var followerDict = followerCounts.ToDictionary(x => x.UserUuid, x => x.Count);

        var socialDict = new Dictionary<Guid, int>();
        if (followingUserIds.Count > 0)
        {
            var followingSet = followingUserIds as HashSet<Guid> ?? followingUserIds.ToHashSet();
            var social = await db.UserFollowers.AsNoTracking()
                .Where(f => userIds.Contains(f.FollowingUserUuid) && followingSet.Contains(f.FollowerUserUuid))
                .GroupBy(f => f.FollowingUserUuid)
                .Select(g => new { UserUuid = g.Key, Count = g.Count() })
                .ToListAsync(cancellationToken);
            socialDict = social.ToDictionary(x => x.UserUuid, x => x.Count);
        }

        return profiles
            .Select(p => new UserRecommendationCandidate
            {
                UserUuid = p.UserUuid,
                DisplayName = p.DisplayName,
                AvatarUuid = p.AvatarUuid,
                FollowerCount = followerDict.GetValueOrDefault(p.UserUuid, 0),
                FollowedByFollowingCount = socialDict.GetValueOrDefault(p.UserUuid, 0),
                UpdatedAt = p.UpdatedAt,
            })
            .ToList();
    }
}
