namespace Flora.Music.Application.Recommendations;

public interface IMusicRecommendationRepository
{
    Task<IReadOnlyList<MusicFlowCandidateRow>> ListPublishedPlatformCandidatesAsync(
        int limit,
        CancellationToken cancellationToken = default);

    Task<IReadOnlyList<MusicFlowCandidateRow>> ListPublishedPlatformCandidatesByScopeAsync(
        string? genreId,
        string? subgenreId,
        int limit,
        CancellationToken cancellationToken = default);

    Task<IReadOnlyDictionary<string, int>> GetUserGenreWeightsAsync(
        Guid userUuid,
        CancellationToken cancellationToken = default);
}

public sealed record MusicFlowCandidateRow(
    Guid TrackUuid,
    Guid OwnerUserUuid,
    string Title,
    string ArtistDisplay,
    string? GenreId,
    string? LicenseId,
    string? CoverColorId,
    string? TrackKindId,
    bool HasCoverImage,
    int DurationMs,
    DateTime CreatedAt,
    DateTime PublishedAt);
