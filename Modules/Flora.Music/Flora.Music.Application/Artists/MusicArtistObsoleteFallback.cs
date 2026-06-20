using Flora.Music.Domain;

namespace Flora.Music.Application.Artists;

public sealed class MusicArtistObsoleteFallback(IMusicArtistRepository repo)
{
    public async Task<IReadOnlyList<TrackArtistCreditInput>> ResolveCreditsAsync(
        IReadOnlyList<TrackArtistCreditInput> credits,
        string? obsoleteArtistDisplay,
        Guid ownerUserUuid,
        CancellationToken ct = default)
    {
        if (credits.Count > 0)
            return credits;

        var name = obsoleteArtistDisplay?.Trim() ?? string.Empty;
        if (!MusicArtistNameNormalizer.IsValidDisplayName(name))
            throw new MusicArtistValidationException("Укажите хотя бы одного исполнителя.");

        var normalized = MusicArtistNameNormalizer.Normalize(name);
        var artist = await repo.FindByNormalizedNameAndCreatorAsync(normalized, ownerUserUuid, ct);
        if (artist == null)
        {
            artist = new MusicArtist
            {
                DisplayName = name,
                NormalizedDisplayName = normalized,
                CreatedByUserUuid = ownerUserUuid,
            };
            await repo.AddAsync(artist, ct);
        }

        return [new TrackArtistCreditInput(artist.ArtistUuid, TrackArtistJoiner.None)];
    }
}
