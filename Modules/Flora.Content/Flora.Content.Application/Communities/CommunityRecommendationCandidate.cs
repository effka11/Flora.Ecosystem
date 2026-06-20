namespace Flora.Content.Application.Communities;

public sealed class CommunityRecommendationCandidate
{
    public Guid CommunityId { get; init; }
    public string Name { get; init; } = "";
    public string Slug { get; init; } = "";
    public Guid? AvatarUuid { get; init; }
    public DateTime CreatedAt { get; init; }
    public int MemberCount { get; init; }
    public int RecentPostCount { get; init; }
    public int FollowedMembersCount { get; init; }
}
