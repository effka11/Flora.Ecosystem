using Flora.Music.Application.Genres;
using Flora.Music.Application.Tracks;
using Flora.Music.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Music.Infrastructure;

public sealed class MusicGenreRepository(MusicDbContext db) : IMusicGenreRepository
{
    private static IQueryable<MusicTrack> PublishedPlatform(IQueryable<MusicTrack> query) =>
        query.Where(t => t.Scope == TrackScope.Platform && t.PublishedAt != null);

    public Task<int> CountPlatformTracksByScopeAsync(
        string? genreId,
        string? subgenreId,
        CancellationToken cancellationToken = default) =>
        MusicGenreScope.Apply(PublishedPlatform(db.MusicTracks.AsNoTracking()), genreId, subgenreId)
            .CountAsync(cancellationToken);

    public async Task<IReadOnlyList<MusicTrackCatalogRow>> ListNewPlatformTracksByScopeAsync(
        string? genreId,
        string? subgenreId,
        int take,
        CancellationToken cancellationToken = default)
    {
        var limit = Math.Clamp(take, 1, 50);
        return await SelectCatalogRows(
                MusicGenreScope.Apply(PublishedPlatform(db.MusicTracks.AsNoTracking()), genreId, subgenreId)
                    .OrderByDescending(t => t.PublishedAt))
            .Take(limit)
            .ToListAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<MusicTrackCatalogRow>> ListPopularPlatformTracksByScopeAsync(
        string? genreId,
        string? subgenreId,
        int take,
        CancellationToken cancellationToken = default)
    {
        var limit = Math.Clamp(take, 1, 50);
        return await SelectCatalogRows(
                MusicGenreScope.Apply(PublishedPlatform(db.MusicTracks.AsNoTracking()), genreId, subgenreId)
                    .OrderByDescending(t => t.CreatedAt)
                    .ThenByDescending(t => t.PublishedAt))
            .Take(limit)
            .ToListAsync(cancellationToken);
    }

    private static IQueryable<MusicTrackCatalogRow> SelectCatalogRows(IQueryable<MusicTrack> query) =>
        query.Select(t => new MusicTrackCatalogRow(
            t.TrackUuid,
            t.OwnerUserUuid,
            t.Title,
            t.ArtistDisplay,
            t.GenreId,
            t.LicenseId,
            t.CoverColorId,
            t.TrackKindId,
            t.CoverData != null && t.CoverData.Length > 0,
            t.DurationMs,
            t.CreatedAt,
            t.PublishedAt!.Value));
}
