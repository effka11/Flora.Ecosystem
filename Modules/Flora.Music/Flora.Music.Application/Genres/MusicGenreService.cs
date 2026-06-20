using Flora.Music.Application.Tracks;
using Flora.Music.Contracts;

namespace Flora.Music.Application.Genres;

public sealed class MusicGenreService(IMusicGenreRepository repo, MusicTrackDtoMapper trackMapper) : IMusicGenreService
{
    private const int CollectionTake = 12;

    public async Task<MusicGenreCatalogDto> GetCatalogAsync(CancellationToken cancellationToken = default)
    {
        var genres = new List<MusicGenreDto>(MusicGenreCatalog.Entries.Count);
        foreach (var entry in MusicGenreCatalog.Entries)
        {
            var subgenres = new List<MusicSubgenreDto>(entry.Subgenres.Count);
            foreach (var subgenre in entry.Subgenres)
            {
                var subgenreCount = await repo.CountPlatformTracksByScopeAsync(entry.Id, subgenre.Id, cancellationToken);
                subgenres.Add(new MusicSubgenreDto(subgenre.Id, subgenre.Title, null, subgenreCount));
            }

            var genreCount = await repo.CountPlatformTracksByScopeAsync(entry.Id, null, cancellationToken);
            genres.Add(new MusicGenreDto(entry.Id, entry.Title, null, genreCount, subgenres));
        }

        return new MusicGenreCatalogDto(genres);
    }

    public async Task<MusicGenrePageDto?> GetPageAsync(
        Guid requesterUserUuid,
        string genreId,
        string? subgenreId = null,
        CancellationToken cancellationToken = default)
    {
        var genreEntry = MusicGenreCatalog.FindGenre(genreId);
        if (genreEntry == null)
            return null;

        if (!string.IsNullOrWhiteSpace(subgenreId) && MusicGenreCatalog.FindSubgenre(genreId, subgenreId) == null)
            return null;

        var scopeGenreId = genreId;
        var scopeSubgenreId = string.IsNullOrWhiteSpace(subgenreId) ? null : subgenreId;

        var subgenres = new List<MusicSubgenreDto>(genreEntry.Subgenres.Count);
        foreach (var subgenre in genreEntry.Subgenres)
        {
            var count = await repo.CountPlatformTracksByScopeAsync(scopeGenreId, subgenre.Id, cancellationToken);
            subgenres.Add(new MusicSubgenreDto(subgenre.Id, subgenre.Title, null, count));
        }

        var genreTrackCount = await repo.CountPlatformTracksByScopeAsync(scopeGenreId, null, cancellationToken);
        var genreDto = new MusicGenreDto(genreEntry.Id, genreEntry.Title, null, genreTrackCount, subgenres);

        MusicSubgenreDto? activeSubgenre = null;
        if (!string.IsNullOrWhiteSpace(scopeSubgenreId))
        {
            var activeEntry = MusicGenreCatalog.FindSubgenre(genreId, scopeSubgenreId)!;
            var activeCount = await repo.CountPlatformTracksByScopeAsync(scopeGenreId, scopeSubgenreId, cancellationToken);
            activeSubgenre = new MusicSubgenreDto(activeEntry.Id, activeEntry.Title, null, activeCount);
        }

        var newTracks = await repo.ListNewPlatformTracksByScopeAsync(scopeGenreId, scopeSubgenreId, CollectionTake, cancellationToken);
        var popularTracks = await repo.ListPopularPlatformTracksByScopeAsync(scopeGenreId, scopeSubgenreId, CollectionTake, cancellationToken);

        var collections = new List<MusicGenreCollectionDto>
        {
            await BuildPlatformCollectionAsync("popular", "Популярное", popularTracks, requesterUserUuid, cancellationToken),
            await BuildPlatformCollectionAsync("new", "Новое", newTracks, requesterUserUuid, cancellationToken),
        };

        return new MusicGenrePageDto(genreDto, activeSubgenre, collections);
    }

    private async Task<MusicGenreCollectionDto> BuildPlatformCollectionAsync(
        string id,
        string title,
        IReadOnlyList<MusicTrackCatalogRow> rows,
        Guid requesterUserUuid,
        CancellationToken ct)
    {
        var platformTracks = await trackMapper.MapPlatformCatalogRowsAsync(rows, requesterUserUuid, ct);
        var tracks = platformTracks.Select(MapGenreTrack).ToList();
        return new MusicGenreCollectionDto(id, title, tracks);
    }

    private static MusicTrackDto MapGenreTrack(MusicPlatformTrackDto row) => new(
        row.TrackUuid,
        MusicTrackScopeDto.Platform,
        row.Title,
        row.ArtistDisplay,
        null,
        row.GenreId,
        row.LicenseId,
        row.CoverColorId,
        row.TrackKindId,
        row.HasCoverImage,
        row.DurationMs,
        row.CreatedAt,
        row.PublishedAt,
        row.ArtistCredits);
}
