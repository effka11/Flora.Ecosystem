using Flora.Music.Application.Tracks;

namespace Flora.Music.Application.Genres;

public interface IMusicGenreRepository
{
    Task<int> CountPlatformTracksByScopeAsync(
        string? genreId,
        string? subgenreId,
        CancellationToken cancellationToken = default);

    Task<IReadOnlyList<MusicTrackCatalogRow>> ListNewPlatformTracksByScopeAsync(
        string? genreId,
        string? subgenreId,
        int take,
        CancellationToken cancellationToken = default);

    Task<IReadOnlyList<MusicTrackCatalogRow>> ListPopularPlatformTracksByScopeAsync(
        string? genreId,
        string? subgenreId,
        int take,
        CancellationToken cancellationToken = default);
}
