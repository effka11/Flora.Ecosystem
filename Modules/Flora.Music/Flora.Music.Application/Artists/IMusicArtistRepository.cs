using Flora.Music.Domain;

namespace Flora.Music.Application.Artists;

public interface IMusicArtistRepository
{
    Task<MusicArtist?> FindByUuidAsync(Guid artistUuid, CancellationToken ct = default);
    Task<MusicArtistCoverRow?> FindCoverAsync(Guid artistUuid, CancellationToken ct = default);
    Task<IReadOnlyList<MusicArtist>> FindByUuidsAsync(IReadOnlyCollection<Guid> artistUuids, CancellationToken ct = default);
    Task<MusicArtist?> FindByNormalizedNameAndCreatorAsync(string normalizedName, Guid createdByUserUuid, CancellationToken ct = default);
    Task<MusicArtist?> FindLinkedByUserAsync(Guid userUuid, CancellationToken ct = default);
    Task AddAsync(MusicArtist artist, CancellationToken ct = default);
    Task AddTrackArtistsAsync(IReadOnlyList<MusicTrackArtist> credits, CancellationToken ct = default);
    Task<IReadOnlyList<MusicArtist>> ListFeaturedAsync(int take, CancellationToken ct = default);
    Task<IReadOnlyList<MusicArtist>> SearchAsync(string normalizedQuery, int queryLength, int limit, CancellationToken ct = default);
    Task<(IReadOnlyList<MusicTrack> Tracks, int TotalCount)> ListArtistTracksPagedAsync(
        Guid artistUuid, Guid requesterUserUuid, int page, int pageSize, CancellationToken ct = default);
    Task RebuildTracksCountAsync(CancellationToken ct = default);
    Task IncrementTracksCountAsync(IReadOnlyCollection<Guid> artistUuids, CancellationToken ct = default);
    Task DecrementTracksCountAsync(IReadOnlyCollection<Guid> artistUuids, CancellationToken ct = default);
    Task<IReadOnlyList<Guid>> ListArtistUuidsForTrackAsync(Guid trackUuid, CancellationToken ct = default);
    Task<IReadOnlyDictionary<Guid, IReadOnlyList<TrackArtistCreditRow>>> ListCreditsForTracksAsync(
        IReadOnlyCollection<Guid> trackUuids,
        CancellationToken ct = default);
    Task<IReadOnlyList<MusicTrackBackfillRow>> ListTracksForBackfillAsync(CancellationToken ct = default);
    Task<bool> TrackHasArtistsAsync(Guid trackUuid, CancellationToken ct = default);
    Task<int> DeleteOrphanedArtistsAsync(DateTime createdBeforeUtc, CancellationToken ct = default);
}

public sealed record MusicTrackBackfillRow(Guid TrackUuid, Guid OwnerUserUuid, string ArtistDisplay);

public sealed record MusicArtistCoverRow(byte[] Data, string ContentType);

public sealed record TrackArtistCreditRow(
    Guid TrackUuid,
    Guid ArtistUuid,
    string DisplayName,
    TrackArtistJoiner JoinerBefore,
    int SortOrder);
