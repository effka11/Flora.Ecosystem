using Flora.Music.Domain;

namespace Flora.Music.Application.Playlists;

public interface IMusicPlaylistRepository
{
    Task<int> CountFavoritesAsync(Guid userUuid, CancellationToken ct = default);
    Task<int> CountPersonalTracksAsync(Guid ownerUserUuid, CancellationToken ct = default);
    Task<int> CountPlatformTracksAsync(Guid ownerUserUuid, CancellationToken ct = default);
    Task<IReadOnlyList<MusicTrack>> ListFavoriteTracksAsync(Guid userUuid, CancellationToken ct = default);
    Task<IReadOnlyList<MusicTrack>> ListPersonalTracksAsync(Guid ownerUserUuid, CancellationToken ct = default);
    Task<IReadOnlyList<MusicTrack>> ListPlatformTracksAsync(Guid ownerUserUuid, CancellationToken ct = default);
    Task<bool> IsFavoriteAsync(Guid userUuid, Guid trackUuid, CancellationToken ct = default);
    Task AddFavoriteAsync(Guid userUuid, Guid trackUuid, CancellationToken ct = default);
    Task<bool> RemoveFavoriteAsync(Guid userUuid, Guid trackUuid, CancellationToken ct = default);

    Task<IReadOnlyList<MusicPlaylistListRow>> ListUserPlaylistsAsync(Guid ownerUserUuid, CancellationToken ct = default);
    Task<MusicPlaylist?> FindUserPlaylistAsync(Guid ownerUserUuid, Guid playlistUuid, CancellationToken ct = default);
    Task AddPlaylistAsync(MusicPlaylist playlist, CancellationToken ct = default);
    Task<bool> DeletePlaylistAsync(Guid ownerUserUuid, Guid playlistUuid, CancellationToken ct = default);
    Task<IReadOnlyList<MusicTrack>> ListUserPlaylistTracksAsync(Guid ownerUserUuid, Guid playlistUuid, CancellationToken ct = default);
    Task<bool> AddTrackToUserPlaylistAsync(Guid ownerUserUuid, Guid playlistUuid, Guid trackUuid, CancellationToken ct = default);
    Task<bool> RemoveTrackFromUserPlaylistAsync(Guid ownerUserUuid, Guid playlistUuid, Guid trackUuid, CancellationToken ct = default);
    Task<bool> IsTrackOwnedByUserAsync(Guid ownerUserUuid, Guid trackUuid, CancellationToken ct = default);
}

public sealed record MusicPlaylistListRow(
    Guid PlaylistUuid,
    string Title,
    string CoverColorId,
    int TrackCount,
    DateTime CreatedAt);
