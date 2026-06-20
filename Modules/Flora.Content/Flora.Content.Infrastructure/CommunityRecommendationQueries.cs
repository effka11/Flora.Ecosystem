using Flora.Content.Application.Communities;
using Microsoft.EntityFrameworkCore;

namespace Flora.Content.Infrastructure;

public sealed class CommunityRecommendationQueries(ContentDbContext db) : ICommunityRecommendationQueries
{
    public async Task<IReadOnlyList<CommunityRecommendationCandidate>> GetCandidatesAsync(
        Guid userUuid,
        IReadOnlyCollection<Guid> followingUserIds,
        DateTime activitySinceUtc,
        CancellationToken cancellationToken = default)
    {
        var joinedCommunityIds = await db.UserCommunities.AsNoTracking()
            .Where(uc => uc.UserUuid == userUuid)
            .Select(uc => uc.CommunityId)
            .ToListAsync(cancellationToken);

        var communities = await db.Communities.AsNoTracking()
            .Where(c => !c.IsPrivate && !joinedCommunityIds.Contains(c.CommunityId))
            .ToListAsync(cancellationToken);

        if (communities.Count == 0)
            return Array.Empty<CommunityRecommendationCandidate>();

        var communityIds = communities.Select(c => c.CommunityId).ToList();

        var memberCounts = await db.UserCommunities.AsNoTracking()
            .Where(uc => communityIds.Contains(uc.CommunityId))
            .GroupBy(uc => uc.CommunityId)
            .Select(g => new { CommunityId = g.Key, Count = g.Count() })
            .ToListAsync(cancellationToken);
        var memberCountDict = memberCounts.ToDictionary(x => x.CommunityId, x => x.Count);

        var recentPostCounts = await db.UserPosts.AsNoTracking()
            .Where(p =>
                p.CommunityId != null
                && communityIds.Contains(p.CommunityId.Value)
                && !p.IsDeleted
                && p.CreatedAt >= activitySinceUtc)
            .GroupBy(p => p.CommunityId!.Value)
            .Select(g => new { CommunityId = g.Key, Count = g.Count() })
            .ToListAsync(cancellationToken);
        var recentPostDict = recentPostCounts.ToDictionary(x => x.CommunityId, x => x.Count);

        var followedMembersDict = new Dictionary<Guid, int>();
        if (followingUserIds.Count > 0)
        {
            var followedMembers = await db.UserCommunities.AsNoTracking()
                .Where(uc => communityIds.Contains(uc.CommunityId) && followingUserIds.Contains(uc.UserUuid))
                .GroupBy(uc => uc.CommunityId)
                .Select(g => new { CommunityId = g.Key, Count = g.Count() })
                .ToListAsync(cancellationToken);
            followedMembersDict = followedMembers.ToDictionary(x => x.CommunityId, x => x.Count);
        }

        return communities
            .Select(c => new CommunityRecommendationCandidate
            {
                CommunityId = c.CommunityId,
                Name = c.Name,
                Slug = c.Slug,
                AvatarUuid = c.AvatarUuid,
                CreatedAt = c.CreatedAt,
                MemberCount = memberCountDict.GetValueOrDefault(c.CommunityId, 0),
                RecentPostCount = recentPostDict.GetValueOrDefault(c.CommunityId, 0),
                FollowedMembersCount = followedMembersDict.GetValueOrDefault(c.CommunityId, 0),
            })
            .ToList();
    }
}
