using Flora.Music.Application.Genres;
using Flora.Music.Application.Recommendations;
using Flora.Music.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Music.Infrastructure;

public sealed class MusicRecommendationRepository(MusicDbContext db) : IMusicRecommendationRepository
{
    public Task<IReadOnlyList<MusicFlowCandidateRow>> ListPublishedPlatformCandidatesAsync(
        int limit,
        CancellationToken cancellationToken = default) =>
        ListPublishedPlatformCandidatesByScopeAsync(null, null, limit, cancellationToken);

    public async Task<IReadOnlyList<MusicFlowCandidateRow>> ListPublishedPlatformCandidatesByScopeAsync(
        string? genreId,
        string? subgenreId,
        int limit,
        CancellationToken cancellationToken = default)
    {
        var take = Math.Clamp(limit, 1, 2000);
        var query = db.MusicTracks.AsNoTracking()
            .Where(t => t.Scope == TrackScope.Platform && t.PublishedAt != null);

        query = MusicGenreScope.Apply(query, genreId, subgenreId);

        return await query
            .OrderByDescending(t => t.PublishedAt)
            .Take(take)
            .Select(t => new MusicFlowCandidateRow(
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
                t.PublishedAt!.Value))
            .ToListAsync(cancellationToken);
    }

    public async Task<IReadOnlyDictionary<string, int>> GetUserGenreWeightsAsync(
        Guid userUuid,
        CancellationToken cancellationToken = default)
    {
        var ownedGenres = await db.MusicTracks.AsNoTracking()
            .Where(t => t.OwnerUserUuid == userUuid && t.GenreId != null && t.GenreId != "")
            .GroupBy(t => t.GenreId!)
            .Select(g => new { GenreId = g.Key, Count = g.Count() })
            .ToListAsync(cancellationToken);

        var favoriteGenres = await db.MusicFavorites.AsNoTracking()
            .Where(f => f.UserUuid == userUuid)
            .Select(f => f.Track!.GenreId)
            .Where(genreId => genreId != null && genreId != "")
            .GroupBy(genreId => genreId!)
            .Select(g => new { GenreId = g.Key, Count = g.Count() })
            .ToListAsync(cancellationToken);

        var weights = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var row in ownedGenres)
            weights[row.GenreId] = weights.GetValueOrDefault(row.GenreId) + row.Count * 2;
        foreach (var row in favoriteGenres)
            weights[row.GenreId] = weights.GetValueOrDefault(row.GenreId) + row.Count;

        return weights;
    }
}
