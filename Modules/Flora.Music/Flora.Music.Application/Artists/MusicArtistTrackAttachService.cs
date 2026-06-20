using Flora.Music.Domain;

namespace Flora.Music.Application.Artists;

public sealed class MusicArtistTrackAttachService(IMusicArtistRepository artistRepo)
{
    public async Task<(string ArtistDisplay, IReadOnlyList<MusicTrackArtist> Credits)> PrepareCreditsAsync(
        Guid trackUuid,
        IReadOnlyList<TrackArtistCreditInput> inputs,
        CancellationToken ct = default)
    {
        var validationError = MusicArtistCreditValidator.ValidateUploadCredits(inputs);
        if (validationError != null)
            throw new MusicArtistValidationException(validationError);

        var artistUuids = inputs.Select(i => i.ArtistUuid).Distinct().ToArray();
        var artists = await artistRepo.FindByUuidsAsync(artistUuids, ct);
        if (artists.Count != artistUuids.Length)
            throw new MusicArtistValidationException("Один или несколько исполнителей не найдены.");

        var artistMap = artists.ToDictionary(a => a.ArtistUuid);
        var resolved = new List<ResolvedTrackArtistCredit>();
        for (var i = 0; i < inputs.Count; i++)
        {
            var input = inputs[i];
            var artist = artistMap[input.ArtistUuid];
            resolved.Add(new ResolvedTrackArtistCredit(
                input.ArtistUuid,
                artist.DisplayName,
                MusicArtistCreditRoleResolver.Resolve(input.JoinerBefore, i),
                input.JoinerBefore,
                i));
        }

        var artistDisplay = MusicArtistDisplayComposer.Compose(
            resolved.Select(r => (r.DisplayName, r.JoinerBefore)).ToList());

        var credits = resolved.Select(r => new MusicTrackArtist
        {
            TrackUuid = trackUuid,
            ArtistUuid = r.ArtistUuid,
            Role = r.Role,
            JoinerBefore = r.JoinerBefore,
            SortOrder = r.SortOrder,
        }).ToList();

        return (artistDisplay, credits);
    }

    public async Task AttachPreparedCreditsAsync(IReadOnlyList<MusicTrackArtist> credits, CancellationToken ct = default)
    {
        if (credits.Count == 0)
            return;

        await artistRepo.AddTrackArtistsAsync(credits, ct);
        var distinctArtists = credits.Select(c => c.ArtistUuid).Distinct().ToArray();
        await artistRepo.IncrementTracksCountAsync(distinctArtists, ct);
    }
}

public sealed class MusicArtistValidationException(string message) : Exception(message);
