using Flora.Music.Domain;

namespace Flora.Music.Application.Tracks;

public interface IMusicTrackRepository
{
    Task AddAsync(MusicTrack track, CancellationToken ct = default);
    Task<IReadOnlyList<MusicTrack>> ListByOwnerAsync(Guid ownerUserUuid, CancellationToken ct = default);
    Task<IReadOnlyList<MusicTrackCatalogRow>> ListPublishedPlatformCatalogAsync(CancellationToken ct = default);
    Task<MusicTrack?> FindOwnedAsync(Guid ownerUserUuid, Guid trackUuid, CancellationToken ct = default);
    Task<MusicTrackAudioRow?> FindAudioAccessibleAsync(Guid requesterUserUuid, Guid trackUuid, CancellationToken ct = default);
    Task<MusicTrackCoverRow?> FindCoverAccessibleAsync(Guid requesterUserUuid, Guid trackUuid, CancellationToken ct = default);
    Task<bool> DeleteOwnedAsync(Guid ownerUserUuid, Guid trackUuid, CancellationToken ct = default);
}

public sealed record MusicTrackAudioRow(byte[] Data, string ContentType);

public sealed record MusicTrackCoverRow(byte[] Data, string ContentType);

public sealed record MusicTrackCatalogRow(
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
