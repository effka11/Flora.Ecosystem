namespace Flora.Users.Application.People;

public interface IUserRecommendationQueries
{
    Task<IReadOnlyList<UserRecommendationCandidate>> GetCandidatesAsync(
        Guid userUuid,
        IReadOnlyCollection<Guid> followingUserIds,
        CancellationToken cancellationToken = default);
}
