using Flora.Music.Contracts;

namespace Flora.Music.Application.Playlists;

public interface IMusicPlaylistService
{
    Task<MusicPlaylistsDto> ListPlaylistsAsync(Guid userUuid, CancellationToken ct = default);
    Task<MusicPlaylistDetailDto?> GetPlaylistAsync(Guid userUuid, string playlistId, CancellationToken ct = default);
    Task<CreateMusicPlaylistResultDto> CreatePlaylistAsync(Guid userUuid, string title, CancellationToken ct = default);
    Task<bool> DeletePlaylistAsync(Guid userUuid, string playlistId, CancellationToken ct = default);
    Task<bool> AddFavoriteAsync(Guid userUuid, Guid trackUuid, CancellationToken ct = default);
    Task<bool> RemoveFavoriteAsync(Guid userUuid, Guid trackUuid, CancellationToken ct = default);
}

public sealed class MusicPlaylistValidationException(string message) : Exception(message);

public sealed class MusicPlaylistForbiddenException(string message) : Exception(message);
