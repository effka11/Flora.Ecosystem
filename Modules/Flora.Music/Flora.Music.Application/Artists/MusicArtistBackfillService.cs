using Flora.Music.Domain;

namespace Flora.Music.Application.Artists;

public sealed class MusicArtistBackfillService(IMusicArtistRepository repo)
{
    public async Task RunAsync(CancellationToken ct = default)
    {
        var tracks = await repo.ListTracksForBackfillAsync(ct);
        foreach (var track in tracks)
        {
            if (await repo.TrackHasArtistsAsync(track.TrackUuid, ct))
                continue;

            var segments = MusicArtistDisplayParser.Parse(track.ArtistDisplay);
            if (segments.Count == 0)
                continue;

            var sortOrder = 0;
            var credits = new List<MusicTrackArtist>();

            foreach (var segment in segments)
            {
                if (!MusicArtistNameNormalizer.IsValidDisplayName(segment.Name))
                    continue;

                var normalized = MusicArtistNameNormalizer.Normalize(segment.Name);
                var artist = await repo.FindByNormalizedNameAndCreatorAsync(normalized, track.OwnerUserUuid, ct);
                if (artist == null)
                {
                    artist = new MusicArtist
                    {
                        DisplayName = segment.Name.Trim(),
                        NormalizedDisplayName = normalized,
                        CreatedByUserUuid = track.OwnerUserUuid,
                    };
                    await repo.AddAsync(artist, ct);
                }

                var joiner = segment.JoinerBefore == BackfillTrackArtistJoiner.Unrecognized
                    ? TrackArtistJoiner.None
                    : MusicArtistCreditRoleResolver.MapBackfillJoiner(segment.JoinerBefore);

                var role = MusicArtistCreditRoleResolver.Resolve(joiner, sortOrder);

                credits.Add(new MusicTrackArtist
                {
                    TrackUuid = track.TrackUuid,
                    ArtistUuid = artist.ArtistUuid,
                    Role = role,
                    JoinerBefore = joiner,
                    SortOrder = sortOrder,
                });

                sortOrder++;
            }

            if (credits.Count == 0)
                continue;

            await repo.AddTrackArtistsAsync(credits, ct);
        }

        await repo.RebuildTracksCountAsync(ct);
    }
}
