using Flora.Music.Domain;

namespace Flora.Music.Application.Genres;

public static class MusicGenreScope
{
    public static IQueryable<MusicTrack> Apply(IQueryable<MusicTrack> query, string? genreId, string? subgenreId)
    {
        if (!string.IsNullOrWhiteSpace(subgenreId))
            return query.Where(t => t.GenreId == subgenreId);

        if (!string.IsNullOrWhiteSpace(genreId))
        {
            var prefix = genreId + "-";
            return query.Where(t =>
                t.GenreId == genreId
                || (t.GenreId != null && t.GenreId.StartsWith(prefix)));
        }

        return query;
    }
}
