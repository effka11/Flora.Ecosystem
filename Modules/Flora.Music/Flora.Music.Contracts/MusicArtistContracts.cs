namespace Flora.Music.Contracts;

public enum TrackArtistJoinerDto
{
    None = 0,
    And = 1,
    Ft = 2,
    Vs = 3,
    Prod = 4,
    Mix = 5,
    Remix = 6,
    Edit = 7,
    Pres = 8,
}

public sealed record MusicArtistSummaryDto(
    Guid ArtistUuid,
    string DisplayName,
    Guid? LinkedUserUuid,
    Guid CreatedByUserUuid,
    int TracksCount,
    bool HasCoverImage);

public sealed record MusicArtistDetailDto(
    Guid ArtistUuid,
    string DisplayName,
    Guid? LinkedUserUuid,
    Guid CreatedByUserUuid,
    int TracksCount,
    bool HasCoverImage);

public sealed record CreateMusicArtistRequest(
    string DisplayName,
    bool LinkToMyProfile,
    byte[]? CoverBytes,
    string? CoverContentType);

public sealed record CreateMusicArtistResultDto(Guid ArtistUuid, string DisplayName, bool HasCoverImage);

public sealed record MusicArtistCoverStreamInfo(byte[] Data, string ContentType);

public sealed record TrackArtistCreditInputDto(Guid ArtistUuid, TrackArtistJoinerDto JoinerBefore);

public sealed record TrackArtistCreditDto(
    Guid ArtistUuid,
    string DisplayName,
    TrackArtistJoinerDto JoinerBefore);

public sealed record PagedMusicTracksDto(
    IReadOnlyList<MusicTrackDto> Tracks,
    int TotalCount,
    int Page,
    int PageSize);

public interface IMusicArtistService
{
    Task<CreateMusicArtistResultDto> CreateAsync(CreateMusicArtistRequest request, Guid actorUserUuid, CancellationToken ct = default);
    Task<MusicArtistDetailDto?> GetAsync(Guid artistUuid, CancellationToken ct = default);
    Task<IReadOnlyList<MusicArtistSummaryDto>> ListFeaturedAsync(int take, CancellationToken ct = default);
    Task<IReadOnlyList<MusicArtistSummaryDto>> SearchAsync(string query, int limit, CancellationToken ct = default);
    Task<PagedMusicTracksDto?> GetArtistTracksAsync(Guid artistUuid, Guid requesterUserUuid, int page, int pageSize, CancellationToken ct = default);
    Task<MusicArtistCoverStreamInfo?> GetCoverAsync(Guid artistUuid, CancellationToken ct = default);
}
