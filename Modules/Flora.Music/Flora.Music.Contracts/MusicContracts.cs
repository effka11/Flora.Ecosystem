namespace Flora.Music.Contracts;

public enum MusicTrackScopeDto
{
    Personal = 0,
    Platform = 1,
}

public sealed record MusicTrackDto(
    Guid TrackUuid,
    MusicTrackScopeDto Scope,
    string Title,
    string ArtistDisplay,
    string? Tags,
    string? GenreId,
    string? LicenseId,
    string? CoverColorId,
    string? TrackKindId,
    bool HasCoverImage,
    int DurationMs,
    DateTime CreatedAt,
    DateTime? PublishedAt,
    IReadOnlyList<TrackArtistCreditDto> ArtistCredits);

public sealed record MusicLibraryDto(IReadOnlyList<MusicTrackDto> Tracks);

public sealed record MusicPlatformTrackDto(
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

public sealed record MusicPlatformCatalogDto(IReadOnlyList<MusicPlatformTrackDto> Tracks);

public sealed record UploadMusicTrackResultDto(Guid TrackUuid, string Title, string ArtistDisplay);

public enum MusicPlaylistKindDto
{
    System = 0,
    User = 1,
}

public sealed record MusicPlaylistSummaryDto(
    string Id,
    string Title,
    int TrackCount,
    MusicPlaylistKindDto Kind,
    string Variant,
    bool CanDelete,
    string? CoverColorId);

public sealed record MusicPlaylistsDto(IReadOnlyList<MusicPlaylistSummaryDto> Playlists);

public sealed record MusicPlaylistDetailDto(
    string Id,
    string Title,
    int TrackCount,
    MusicPlaylistKindDto Kind,
    string Variant,
    bool CanDelete,
    string? CoverColorId,
    IReadOnlyList<MusicTrackDto> Tracks);

public sealed record CreateMusicPlaylistResultDto(string PlaylistId, string Title);
