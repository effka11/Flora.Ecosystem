namespace Flora.Content.Application.Communities;

public interface ICommunityRecommendationQueries
{
    Task<IReadOnlyList<CommunityRecommendationCandidate>> GetCandidatesAsync(
        Guid userUuid,
        IReadOnlyCollection<Guid> followingUserIds,
        DateTime activitySinceUtc,
        CancellationToken cancellationToken = default);
}
