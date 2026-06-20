namespace Flora.Music.Contracts;

public sealed record MusicFlowTrackDto(
    Guid TrackUuid,
    string Title,
    string ArtistDisplay,
    string? GenreId,
    string? LicenseId,
    string? CoverColorId,
    string? TrackKindId,
    bool HasCoverImage,
    int DurationMs,
    DateTime CreatedAt,
    DateTime PublishedAt,
    bool IsOwnedByCurrentUser,
    IReadOnlyList<TrackArtistCreditDto> ArtistCredits);

public sealed record MusicFlowWaveDto(
    IReadOnlyList<MusicFlowTrackDto> Tracks,
    DateTime GeneratedAt,
    DateTime ExpiresAt);

public sealed record MusicFlowWaveRequest(
    int Take = 20,
    IReadOnlyList<Guid>? ExcludeTrackUuids = null,
    string? GenreId = null,
    string? SubgenreId = null);

public interface IMusicRecommendationService
{
    Task<MusicFlowWaveDto> GetFlowWaveAsync(
        Guid userUuid,
        MusicFlowWaveRequest request,
        CancellationToken cancellationToken = default);

    DateTime? GetCacheGeneratedAt(Guid userUuid);

    DateTime? GetCacheExpiresAt(Guid userUuid);
}

public sealed class MusicRecommendationOptions
{
    public const string SectionName = "FiraMusic";

    public double WeightAlpha { get; set; } = 0.0;

    public double WeightBeta { get; set; } = 0.75;

    public double WeightGamma { get; set; } = 0.25;

    public double ExplorationQuota { get; set; } = 0.15;

    public int CacheTtlSeconds { get; set; } = 180;

    public int RecencyBoostDays { get; set; } = 14;

    public int MaxCandidates { get; set; } = 500;
}
