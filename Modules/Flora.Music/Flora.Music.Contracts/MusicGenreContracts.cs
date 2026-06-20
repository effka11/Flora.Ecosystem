namespace Flora.Music.Contracts;

public sealed record MusicSubgenreDto(
    string Id,
    string Title,
    string? Description,
    int TrackCount);

public sealed record MusicGenreDto(
    string Id,
    string Title,
    string? Description,
    int TrackCount,
    IReadOnlyList<MusicSubgenreDto> Subgenres);

public sealed record MusicGenreCollectionDto(
    string Id,
    string Title,
    IReadOnlyList<MusicTrackDto> Tracks);

public sealed record MusicGenrePageDto(
    MusicGenreDto Genre,
    MusicSubgenreDto? ActiveSubgenre,
    IReadOnlyList<MusicGenreCollectionDto> Collections);

public sealed record MusicGenreCatalogDto(IReadOnlyList<MusicGenreDto> Genres);

public interface IMusicGenreService
{
    Task<MusicGenreCatalogDto> GetCatalogAsync(CancellationToken cancellationToken = default);

    Task<MusicGenrePageDto?> GetPageAsync(
        Guid requesterUserUuid,
        string genreId,
        string? subgenreId = null,
        CancellationToken cancellationToken = default);
}
