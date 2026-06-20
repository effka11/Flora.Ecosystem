using Flora.Music.Application.Artists;
using Flora.Music.Application.Recommendations;
using Flora.Music.Contracts;
using Flora.Music.Domain;

namespace Flora.Music.Application.Tracks;

public sealed class MusicTrackDtoMapper(IMusicArtistRepository artistRepo)
{
    private static readonly IReadOnlyList<TrackArtistCreditDto> EmptyCredits = [];

    public async Task<IReadOnlyList<MusicTrackDto>> MapTracksAsync(
        IReadOnlyList<MusicTrack> tracks,
        CancellationToken ct = default)
    {
        if (tracks.Count == 0)
            return [];

        var creditMap = await LoadCreditMapAsync(tracks.Select(t => t.TrackUuid).ToArray(), ct);
        return tracks.Select(t => MapTrack(t, creditMap)).ToList();
    }

    public async Task<IReadOnlyList<MusicPlatformTrackDto>> MapPlatformCatalogRowsAsync(
        IReadOnlyList<MusicTrackCatalogRow> tracks,
        Guid requesterUserUuid,
        CancellationToken ct = default)
    {
        if (tracks.Count == 0)
            return [];

        var creditMap = await LoadCreditMapAsync(tracks.Select(t => t.TrackUuid).ToArray(), ct);
        return tracks.Select(t => MapPlatformRow(t, requesterUserUuid, creditMap)).ToList();
    }

    public async Task<IReadOnlyList<MusicFlowTrackDto>> MapFlowRowsAsync(
        IReadOnlyList<MusicFlowCandidateRow> tracks,
        Guid requesterUserUuid,
        CancellationToken ct = default)
    {
        if (tracks.Count == 0)
            return [];

        var creditMap = await LoadCreditMapAsync(tracks.Select(t => t.TrackUuid).ToArray(), ct);
        return tracks.Select(t => MapFlowRow(t, requesterUserUuid, creditMap)).ToList();
    }

    private async Task<IReadOnlyDictionary<Guid, IReadOnlyList<TrackArtistCreditDto>>> LoadCreditMapAsync(
        Guid[] trackUuids,
        CancellationToken ct)
    {
        var rows = await artistRepo.ListCreditsForTracksAsync(trackUuids, ct);
        return rows.ToDictionary(
            entry => entry.Key,
            entry => (IReadOnlyList<TrackArtistCreditDto>)entry.Value.Select(MapCredit).ToList());
    }

    private static TrackArtistCreditDto MapCredit(TrackArtistCreditRow row) => new(
        row.ArtistUuid,
        row.DisplayName,
        MapJoiner(row.JoinerBefore));

    private static TrackArtistJoinerDto MapJoiner(TrackArtistJoiner joiner) => joiner switch
    {
        TrackArtistJoiner.And => TrackArtistJoinerDto.And,
        TrackArtistJoiner.Ft => TrackArtistJoinerDto.Ft,
        TrackArtistJoiner.Vs => TrackArtistJoinerDto.Vs,
        TrackArtistJoiner.Prod => TrackArtistJoinerDto.Prod,
        TrackArtistJoiner.Mix => TrackArtistJoinerDto.Mix,
        TrackArtistJoiner.Remix => TrackArtistJoinerDto.Remix,
        TrackArtistJoiner.Edit => TrackArtistJoinerDto.Edit,
        TrackArtistJoiner.Pres => TrackArtistJoinerDto.Pres,
        _ => TrackArtistJoinerDto.None,
    };

    private static IReadOnlyList<TrackArtistCreditDto> CreditsFor(
        IReadOnlyDictionary<Guid, IReadOnlyList<TrackArtistCreditDto>> map,
        Guid trackUuid) =>
        map.TryGetValue(trackUuid, out var credits) ? credits : EmptyCredits;

    private static MusicTrackDto MapTrack(
        MusicTrack track,
        IReadOnlyDictionary<Guid, IReadOnlyList<TrackArtistCreditDto>> creditMap) => new(
        track.TrackUuid,
        track.Scope == TrackScope.Platform ? MusicTrackScopeDto.Platform : MusicTrackScopeDto.Personal,
        track.Title,
        track.ArtistDisplay,
        track.Tags,
        track.GenreId,
        track.LicenseId,
        track.CoverColorId,
        track.TrackKindId,
        track.CoverData is { Length: > 0 },
        track.DurationMs,
        track.CreatedAt,
        track.PublishedAt,
        CreditsFor(creditMap, track.TrackUuid));

    private static MusicPlatformTrackDto MapPlatformRow(
        MusicTrackCatalogRow track,
        Guid requesterUserUuid,
        IReadOnlyDictionary<Guid, IReadOnlyList<TrackArtistCreditDto>> creditMap) => new(
        track.TrackUuid,
        track.Title,
        track.ArtistDisplay,
        track.GenreId,
        track.LicenseId,
        track.CoverColorId,
        track.TrackKindId,
        track.HasCoverImage,
        track.DurationMs,
        track.CreatedAt,
        track.PublishedAt,
        track.OwnerUserUuid == requesterUserUuid,
        CreditsFor(creditMap, track.TrackUuid));

    private static MusicFlowTrackDto MapFlowRow(
        MusicFlowCandidateRow track,
        Guid requesterUserUuid,
        IReadOnlyDictionary<Guid, IReadOnlyList<TrackArtistCreditDto>> creditMap) => new(
        track.TrackUuid,
        track.Title,
        track.ArtistDisplay,
        track.GenreId,
        track.LicenseId,
        track.CoverColorId,
        track.TrackKindId,
        track.HasCoverImage,
        track.DurationMs,
        track.CreatedAt,
        track.PublishedAt,
        track.OwnerUserUuid == requesterUserUuid,
        CreditsFor(creditMap, track.TrackUuid));
}
