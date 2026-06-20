namespace Flora.Users.Application.People;

public sealed class UserRecommendationCandidate
{
    public Guid UserUuid { get; init; }
    public string DisplayName { get; init; } = "";
    public Guid? AvatarUuid { get; init; }
    public int FollowerCount { get; init; }
    public int FollowedByFollowingCount { get; init; }
    public DateTime UpdatedAt { get; init; }
}
