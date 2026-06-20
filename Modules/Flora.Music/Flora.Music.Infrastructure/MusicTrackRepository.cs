using Flora.Music.Application.Tracks;
using Flora.Music.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Music.Infrastructure;

public sealed class MusicTrackRepository(MusicDbContext db) : IMusicTrackRepository
{
    public async Task AddAsync(MusicTrack track, CancellationToken ct = default)
    {
        db.MusicTracks.Add(track);
        await db.SaveChangesAsync(ct);
    }

    public async Task<IReadOnlyList<MusicTrack>> ListByOwnerAsync(Guid ownerUserUuid, CancellationToken ct = default)
    {
        var tracks = await db.MusicTracks.AsNoTracking()
            .Where(t => t.OwnerUserUuid == ownerUserUuid)
            .OrderByDescending(t => t.CreatedAt)
            .ToListAsync(ct);
        return tracks;
    }

    public async Task<IReadOnlyList<MusicTrackCatalogRow>> ListPublishedPlatformCatalogAsync(CancellationToken ct = default)
    {
        return await db.MusicTracks.AsNoTracking()
            .Where(t => t.Scope == TrackScope.Platform && t.PublishedAt != null)
            .OrderByDescending(t => t.PublishedAt)
            .Select(t => new MusicTrackCatalogRow(
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
            .ToListAsync(ct);
    }

    public Task<MusicTrack?> FindOwnedAsync(Guid ownerUserUuid, Guid trackUuid, CancellationToken ct = default) =>
        db.MusicTracks.FirstOrDefaultAsync(
            t => t.TrackUuid == trackUuid && t.OwnerUserUuid == ownerUserUuid, ct);

    public async Task<MusicTrackAudioRow?> FindAudioAccessibleAsync(Guid requesterUserUuid, Guid trackUuid, CancellationToken ct = default)
    {
        var row = await db.MusicTracks.AsNoTracking()
            .Where(t => t.TrackUuid == trackUuid)
            .Where(t => t.OwnerUserUuid == requesterUserUuid || (t.Scope == TrackScope.Platform && t.PublishedAt != null))
            .Select(t => new { t.AudioData, t.ContentType })
            .FirstOrDefaultAsync(ct);

        if (row == null)
            return null;

        return new MusicTrackAudioRow(row.AudioData, row.ContentType);
    }

    public async Task<MusicTrackCoverRow?> FindCoverAccessibleAsync(Guid requesterUserUuid, Guid trackUuid, CancellationToken ct = default)
    {
        var row = await db.MusicTracks.AsNoTracking()
            .Where(t => t.TrackUuid == trackUuid)
            .Where(t => t.OwnerUserUuid == requesterUserUuid || (t.Scope == TrackScope.Platform && t.PublishedAt != null))
            .Select(t => new { t.CoverData, t.CoverContentType })
            .FirstOrDefaultAsync(ct);

        if (row?.CoverData is not { Length: > 0 } coverData)
            return null;

        var contentType = string.IsNullOrWhiteSpace(row.CoverContentType)
            ? "application/octet-stream"
            : row.CoverContentType;

        return new MusicTrackCoverRow(coverData, contentType);
    }

    public async Task<bool> DeleteOwnedAsync(Guid ownerUserUuid, Guid trackUuid, CancellationToken ct = default)
    {
        var track = await db.MusicTracks.FirstOrDefaultAsync(
            t => t.TrackUuid == trackUuid && t.OwnerUserUuid == ownerUserUuid, ct);
        if (track == null)
            return false;

        db.MusicTracks.Remove(track);
        await db.SaveChangesAsync(ct);
        return true;
    }
}
