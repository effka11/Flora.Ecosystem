using Flora.Music.Application.Playlists;
using Flora.Music.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Music.Infrastructure;

public sealed class MusicPlaylistRepository(MusicDbContext db) : IMusicPlaylistRepository
{
    public Task<int> CountFavoritesAsync(Guid userUuid, CancellationToken ct = default) =>
        db.MusicFavorites.AsNoTracking()
            .CountAsync(f => f.UserUuid == userUuid, ct);

    public Task<int> CountPersonalTracksAsync(Guid ownerUserUuid, CancellationToken ct = default) =>
        db.MusicTracks.AsNoTracking()
            .CountAsync(t => t.OwnerUserUuid == ownerUserUuid && t.Scope == TrackScope.Personal, ct);

    public Task<int> CountPlatformTracksAsync(Guid ownerUserUuid, CancellationToken ct = default) =>
        db.MusicTracks.AsNoTracking()
            .CountAsync(t => t.OwnerUserUuid == ownerUserUuid && t.Scope == TrackScope.Platform, ct);

    public async Task<IReadOnlyList<MusicTrack>> ListFavoriteTracksAsync(Guid userUuid, CancellationToken ct = default)
    {
        return await db.MusicFavorites.AsNoTracking()
            .Where(f => f.UserUuid == userUuid)
            .OrderByDescending(f => f.CreatedAt)
            .Select(f => f.Track!)
            .ToListAsync(ct);
    }

    public async Task<IReadOnlyList<MusicTrack>> ListPersonalTracksAsync(Guid ownerUserUuid, CancellationToken ct = default)
    {
        return await db.MusicTracks.AsNoTracking()
            .Where(t => t.OwnerUserUuid == ownerUserUuid && t.Scope == TrackScope.Personal)
            .OrderByDescending(t => t.CreatedAt)
            .ToListAsync(ct);
    }

    public async Task<IReadOnlyList<MusicTrack>> ListPlatformTracksAsync(Guid ownerUserUuid, CancellationToken ct = default)
    {
        return await db.MusicTracks.AsNoTracking()
            .Where(t => t.OwnerUserUuid == ownerUserUuid && t.Scope == TrackScope.Platform)
            .OrderByDescending(t => t.CreatedAt)
            .ToListAsync(ct);
    }

    public Task<bool> IsFavoriteAsync(Guid userUuid, Guid trackUuid, CancellationToken ct = default) =>
        db.MusicFavorites.AsNoTracking()
            .AnyAsync(f => f.UserUuid == userUuid && f.TrackUuid == trackUuid, ct);

    public async Task AddFavoriteAsync(Guid userUuid, Guid trackUuid, CancellationToken ct = default)
    {
        db.MusicFavorites.Add(new MusicFavorite
        {
            UserUuid = userUuid,
            TrackUuid = trackUuid,
        });
        await db.SaveChangesAsync(ct);
    }

    public async Task<bool> RemoveFavoriteAsync(Guid userUuid, Guid trackUuid, CancellationToken ct = default)
    {
        var favorite = await db.MusicFavorites
            .FirstOrDefaultAsync(f => f.UserUuid == userUuid && f.TrackUuid == trackUuid, ct);
        if (favorite == null)
            return false;

        db.MusicFavorites.Remove(favorite);
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<IReadOnlyList<MusicPlaylistListRow>> ListUserPlaylistsAsync(Guid ownerUserUuid, CancellationToken ct = default)
    {
        return await db.MusicPlaylists.AsNoTracking()
            .Where(p => p.OwnerUserUuid == ownerUserUuid)
            .OrderByDescending(p => p.CreatedAt)
            .Select(p => new MusicPlaylistListRow(
                p.PlaylistUuid,
                p.Title,
                p.CoverColorId,
                p.Tracks.Count,
                p.CreatedAt))
            .ToListAsync(ct);
    }

    public Task<MusicPlaylist?> FindUserPlaylistAsync(Guid ownerUserUuid, Guid playlistUuid, CancellationToken ct = default) =>
        db.MusicPlaylists.AsNoTracking()
            .FirstOrDefaultAsync(p => p.PlaylistUuid == playlistUuid && p.OwnerUserUuid == ownerUserUuid, ct);

    public async Task AddPlaylistAsync(MusicPlaylist playlist, CancellationToken ct = default)
    {
        db.MusicPlaylists.Add(playlist);
        await db.SaveChangesAsync(ct);
    }

    public async Task<bool> DeletePlaylistAsync(Guid ownerUserUuid, Guid playlistUuid, CancellationToken ct = default)
    {
        var playlist = await db.MusicPlaylists
            .FirstOrDefaultAsync(p => p.PlaylistUuid == playlistUuid && p.OwnerUserUuid == ownerUserUuid, ct);
        if (playlist == null)
            return false;

        db.MusicPlaylists.Remove(playlist);
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<IReadOnlyList<MusicTrack>> ListUserPlaylistTracksAsync(
        Guid ownerUserUuid,
        Guid playlistUuid,
        CancellationToken ct = default)
    {
        var playlistExists = await db.MusicPlaylists.AsNoTracking()
            .AnyAsync(p => p.PlaylistUuid == playlistUuid && p.OwnerUserUuid == ownerUserUuid, ct);
        if (!playlistExists)
            return [];

        return await db.MusicPlaylistTracks.AsNoTracking()
            .Where(pt => pt.PlaylistUuid == playlistUuid)
            .OrderBy(pt => pt.Position)
            .ThenByDescending(pt => pt.AddedAt)
            .Select(pt => pt.Track!)
            .ToListAsync(ct);
    }

    public async Task<bool> AddTrackToUserPlaylistAsync(
        Guid ownerUserUuid,
        Guid playlistUuid,
        Guid trackUuid,
        CancellationToken ct = default)
    {
        var playlist = await db.MusicPlaylists
            .FirstOrDefaultAsync(p => p.PlaylistUuid == playlistUuid && p.OwnerUserUuid == ownerUserUuid, ct);
        if (playlist == null)
            return false;

        if (!await IsTrackOwnedByUserAsync(ownerUserUuid, trackUuid, ct))
            return false;

        var exists = await db.MusicPlaylistTracks
            .AnyAsync(pt => pt.PlaylistUuid == playlistUuid && pt.TrackUuid == trackUuid, ct);
        if (exists)
            return true;

        var maxPosition = await db.MusicPlaylistTracks
            .Where(pt => pt.PlaylistUuid == playlistUuid)
            .Select(pt => (int?)pt.Position)
            .MaxAsync(ct) ?? -1;

        db.MusicPlaylistTracks.Add(new MusicPlaylistTrack
        {
            PlaylistUuid = playlistUuid,
            TrackUuid = trackUuid,
            Position = maxPosition + 1,
        });
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<bool> RemoveTrackFromUserPlaylistAsync(
        Guid ownerUserUuid,
        Guid playlistUuid,
        Guid trackUuid,
        CancellationToken ct = default)
    {
        var playlist = await db.MusicPlaylists.AsNoTracking()
            .AnyAsync(p => p.PlaylistUuid == playlistUuid && p.OwnerUserUuid == ownerUserUuid, ct);
        if (!playlist)
            return false;

        var row = await db.MusicPlaylistTracks
            .FirstOrDefaultAsync(pt => pt.PlaylistUuid == playlistUuid && pt.TrackUuid == trackUuid, ct);
        if (row == null)
            return false;

        db.MusicPlaylistTracks.Remove(row);
        await db.SaveChangesAsync(ct);
        return true;
    }

    public Task<bool> IsTrackOwnedByUserAsync(Guid ownerUserUuid, Guid trackUuid, CancellationToken ct = default) =>
        db.MusicTracks.AsNoTracking()
            .AnyAsync(t => t.TrackUuid == trackUuid && t.OwnerUserUuid == ownerUserUuid, ct);
}
