using Flora.Music.Application.Artists;
using Flora.Music.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Music.Infrastructure;

public sealed class MusicArtistRepository(MusicDbContext db) : IMusicArtistRepository
{
    public Task<MusicArtist?> FindByUuidAsync(Guid artistUuid, CancellationToken ct = default) =>
        db.MusicArtists.AsNoTracking().FirstOrDefaultAsync(a => a.ArtistUuid == artistUuid, ct);

    public Task<MusicArtistCoverRow?> FindCoverAsync(Guid artistUuid, CancellationToken ct = default) =>
        db.MusicArtists.AsNoTracking()
            .Where(a => a.ArtistUuid == artistUuid && a.CoverData != null && a.CoverData.Length > 0)
            .Select(a => new MusicArtistCoverRow(a.CoverData!, a.CoverContentType ?? "image/jpeg"))
            .FirstOrDefaultAsync(ct);

    public async Task<IReadOnlyList<MusicArtist>> FindByUuidsAsync(IReadOnlyCollection<Guid> artistUuids, CancellationToken ct = default)
    {
        if (artistUuids.Count == 0)
            return [];

        return await db.MusicArtists.AsNoTracking()
            .Where(a => artistUuids.Contains(a.ArtistUuid))
            .ToListAsync(ct);
    }

    public Task<MusicArtist?> FindByNormalizedNameAndCreatorAsync(
        string normalizedName, Guid createdByUserUuid, CancellationToken ct = default) =>
        db.MusicArtists.FirstOrDefaultAsync(
            a => a.NormalizedDisplayName == normalizedName && a.CreatedByUserUuid == createdByUserUuid, ct);

    public Task<MusicArtist?> FindLinkedByUserAsync(Guid userUuid, CancellationToken ct = default) =>
        db.MusicArtists.FirstOrDefaultAsync(a => a.LinkedUserUuid == userUuid, ct);

    public async Task AddAsync(MusicArtist artist, CancellationToken ct = default)
    {
        db.MusicArtists.Add(artist);
        await db.SaveChangesAsync(ct);
    }

    public async Task AddTrackArtistsAsync(IReadOnlyList<MusicTrackArtist> credits, CancellationToken ct = default)
    {
        if (credits.Count == 0)
            return;

        db.MusicTrackArtists.AddRange(credits);
        await db.SaveChangesAsync(ct);
    }

    public async Task<IReadOnlyList<MusicArtist>> ListFeaturedAsync(int take, CancellationToken ct = default)
    {
        var clamped = Math.Clamp(take, 1, 50);
        return await db.MusicArtists.AsNoTracking()
            .OrderByDescending(a => a.TracksCount)
            .ThenBy(a => a.DisplayName)
            .Take(clamped)
            .ToListAsync(ct);
    }

    public async Task<IReadOnlyList<MusicArtist>> SearchAsync(
        string normalizedQuery, int queryLength, int limit, CancellationToken ct = default)
    {
        var clampedLimit = Math.Clamp(limit, 1, 20);
        var pattern = queryLength == 1
            ? $"{normalizedQuery}%"
            : $"%{normalizedQuery}%";

        return await db.MusicArtists.AsNoTracking()
            .Where(a => EF.Functions.ILike(a.NormalizedDisplayName, pattern))
            .OrderByDescending(a => a.TracksCount)
            .ThenBy(a => a.DisplayName)
            .Take(clampedLimit)
            .ToListAsync(ct);
    }

    public async Task<(IReadOnlyList<MusicTrack> Tracks, int TotalCount)> ListArtistTracksPagedAsync(
        Guid artistUuid, Guid requesterUserUuid, int page, int pageSize, CancellationToken ct = default)
    {
        var safePage = Math.Max(1, page);
        var safeSize = Math.Clamp(pageSize, 1, 100);

        var query = db.MusicTrackArtists.AsNoTracking()
            .Where(ta => ta.ArtistUuid == artistUuid)
            .Join(
                db.MusicTracks.AsNoTracking(),
                ta => ta.TrackUuid,
                t => t.TrackUuid,
                (_, t) => t)
            .Where(t => t.OwnerUserUuid == requesterUserUuid || (t.Scope == TrackScope.Platform && t.PublishedAt != null))
            .Distinct();

        var total = await query.CountAsync(ct);
        var tracks = await query
            .OrderByDescending(t => t.PublishedAt ?? t.CreatedAt)
            .ThenByDescending(t => t.CreatedAt)
            .Skip((safePage - 1) * safeSize)
            .Take(safeSize)
            .ToListAsync(ct);

        return (tracks, total);
    }

    public async Task RebuildTracksCountAsync(CancellationToken ct = default)
    {
        await db.Database.ExecuteSqlRawAsync("UPDATE flora_core.music_artists SET tracks_count = 0", ct);
        await db.Database.ExecuteSqlRawAsync(
            """
            UPDATE flora_core.music_artists AS a
            SET tracks_count = sub.c
            FROM (
                SELECT artist_uuid, COUNT(DISTINCT track_uuid) AS c
                FROM flora_core.music_track_artists
                GROUP BY artist_uuid
            ) AS sub
            WHERE a.artist_uuid = sub.artist_uuid
            """, ct);
    }

    public async Task IncrementTracksCountAsync(IReadOnlyCollection<Guid> artistUuids, CancellationToken ct = default)
    {
        if (artistUuids.Count == 0)
            return;

        var ids = artistUuids.Distinct().ToArray();
        await db.MusicArtists
            .Where(a => ids.Contains(a.ArtistUuid))
            .ExecuteUpdateAsync(s => s.SetProperty(a => a.TracksCount, a => a.TracksCount + 1), ct);
    }

    public async Task DecrementTracksCountAsync(IReadOnlyCollection<Guid> artistUuids, CancellationToken ct = default)
    {
        if (artistUuids.Count == 0)
            return;

        var ids = artistUuids.Distinct().ToArray();
        await db.MusicArtists
            .Where(a => ids.Contains(a.ArtistUuid) && a.TracksCount > 0)
            .ExecuteUpdateAsync(s => s.SetProperty(a => a.TracksCount, a => a.TracksCount - 1), ct);
    }

    public async Task<IReadOnlyList<Guid>> ListArtistUuidsForTrackAsync(Guid trackUuid, CancellationToken ct = default) =>
        await db.MusicTrackArtists.AsNoTracking()
            .Where(ta => ta.TrackUuid == trackUuid)
            .Select(ta => ta.ArtistUuid)
            .Distinct()
            .ToListAsync(ct);

    public async Task<IReadOnlyDictionary<Guid, IReadOnlyList<TrackArtistCreditRow>>> ListCreditsForTracksAsync(
        IReadOnlyCollection<Guid> trackUuids,
        CancellationToken ct = default)
    {
        if (trackUuids.Count == 0)
            return new Dictionary<Guid, IReadOnlyList<TrackArtistCreditRow>>();

        var rows = await db.MusicTrackArtists.AsNoTracking()
            .Where(ta => trackUuids.Contains(ta.TrackUuid))
            .Join(
                db.MusicArtists.AsNoTracking(),
                ta => ta.ArtistUuid,
                a => a.ArtistUuid,
                (ta, a) => new
                {
                    ta.TrackUuid,
                    ta.ArtistUuid,
                    a.DisplayName,
                    ta.JoinerBefore,
                    ta.SortOrder,
                })
            .OrderBy(r => r.TrackUuid)
            .ThenBy(r => r.SortOrder)
            .ToListAsync(ct);

        return rows
            .GroupBy(r => r.TrackUuid)
            .ToDictionary(
                g => g.Key,
                g => (IReadOnlyList<TrackArtistCreditRow>)g
                    .Select(r => new TrackArtistCreditRow(
                        r.TrackUuid,
                        r.ArtistUuid,
                        r.DisplayName,
                        r.JoinerBefore,
                        r.SortOrder))
                    .ToList());
    }

    public async Task<IReadOnlyList<MusicTrackBackfillRow>> ListTracksForBackfillAsync(CancellationToken ct = default) =>
        await db.MusicTracks.AsNoTracking()
            .Where(t => t.ArtistDisplay != "")
            .Select(t => new MusicTrackBackfillRow(t.TrackUuid, t.OwnerUserUuid, t.ArtistDisplay))
            .ToListAsync(ct);

    public Task<bool> TrackHasArtistsAsync(Guid trackUuid, CancellationToken ct = default) =>
        db.MusicTrackArtists.AsNoTracking().AnyAsync(ta => ta.TrackUuid == trackUuid, ct);

    public async Task<int> DeleteOrphanedArtistsAsync(DateTime createdBeforeUtc, CancellationToken ct = default)
    {
        var orphanIds = await db.MusicArtists
            .Where(a => a.TracksCount == 0 && a.CreatedAt < createdBeforeUtc)
            .Where(a => !db.MusicTrackArtists.Any(ta => ta.ArtistUuid == a.ArtistUuid))
            .Select(a => a.ArtistUuid)
            .ToListAsync(ct);

        if (orphanIds.Count == 0)
            return 0;

        return await db.MusicArtists
            .Where(a => orphanIds.Contains(a.ArtistUuid))
            .ExecuteDeleteAsync(ct);
    }
}
