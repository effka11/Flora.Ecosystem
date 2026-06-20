using Flora.Music.Application.Tracks;
using Flora.Music.Contracts;
using Flora.Music.Domain;

namespace Flora.Music.Application.Playlists;

public sealed class MusicPlaylistService(IMusicPlaylistRepository repo, MusicTrackDtoMapper trackMapper) : IMusicPlaylistService
{
    public async Task<MusicPlaylistsDto> ListPlaylistsAsync(Guid userUuid, CancellationToken ct = default)
    {
        var playlists = new List<MusicPlaylistSummaryDto>();

        var personalCount = await repo.CountPersonalTracksAsync(userUuid, ct);
        if (personalCount > 0)
        {
            playlists.Add(new MusicPlaylistSummaryDto(
                SystemPlaylistIds.UploadedPersonal,
                "Загруженное для себя",
                personalCount,
                MusicPlaylistKindDto.System,
                "uploaded-personal",
                false,
                null));
        }

        var platformCount = await repo.CountPlatformTracksAsync(userUuid, ct);
        if (platformCount > 0)
        {
            playlists.Add(new MusicPlaylistSummaryDto(
                SystemPlaylistIds.UploadedPlatform,
                "Загруженное на площадку",
                platformCount,
                MusicPlaylistKindDto.System,
                "uploaded-platform",
                false,
                null));
        }

        var userPlaylists = await repo.ListUserPlaylistsAsync(userUuid, ct);
        foreach (var row in userPlaylists)
        {
            playlists.Add(new MusicPlaylistSummaryDto(
                row.PlaylistUuid.ToString(),
                row.Title,
                row.TrackCount,
                MusicPlaylistKindDto.User,
                "user",
                true,
                row.CoverColorId));
        }

        return new MusicPlaylistsDto(playlists);
    }

    public async Task<MusicPlaylistDetailDto?> GetPlaylistAsync(Guid userUuid, string playlistId, CancellationToken ct = default)
    {
        if (SystemPlaylistIds.IsSystem(playlistId))
            return await GetSystemPlaylistAsync(userUuid, playlistId, ct);

        if (!Guid.TryParse(playlistId, out var playlistUuid))
            return null;

        var playlist = await repo.FindUserPlaylistAsync(userUuid, playlistUuid, ct);
        if (playlist == null)
            return null;

        var tracks = await repo.ListUserPlaylistTracksAsync(userUuid, playlistUuid, ct);
        var trackDtos = await trackMapper.MapTracksAsync(tracks, ct);
        return new MusicPlaylistDetailDto(
            playlist.PlaylistUuid.ToString(),
            playlist.Title,
            tracks.Count,
            MusicPlaylistKindDto.User,
            "user",
            true,
            playlist.CoverColorId,
            trackDtos);
    }

    public async Task<CreateMusicPlaylistResultDto> CreatePlaylistAsync(Guid userUuid, string title, CancellationToken ct = default)
    {
        var normalized = NormalizePlaylistTitle(title);
        var playlist = new MusicPlaylist
        {
            OwnerUserUuid = userUuid,
            Title = normalized,
        };

        await repo.AddPlaylistAsync(playlist, ct);
        return new CreateMusicPlaylistResultDto(playlist.PlaylistUuid.ToString(), playlist.Title);
    }

    public async Task<bool> DeletePlaylistAsync(Guid userUuid, string playlistId, CancellationToken ct = default)
    {
        if (SystemPlaylistIds.IsSystem(playlistId))
            throw new MusicPlaylistForbiddenException("Системный плейлист нельзя удалить.");

        if (!Guid.TryParse(playlistId, out var playlistUuid))
            return false;

        return await repo.DeletePlaylistAsync(userUuid, playlistUuid, ct);
    }

    public async Task<bool> AddFavoriteAsync(Guid userUuid, Guid trackUuid, CancellationToken ct = default)
    {
        if (!await repo.IsTrackOwnedByUserAsync(userUuid, trackUuid, ct))
            return false;

        if (await repo.IsFavoriteAsync(userUuid, trackUuid, ct))
            return true;

        await repo.AddFavoriteAsync(userUuid, trackUuid, ct);
        return true;
    }

    public async Task<bool> RemoveFavoriteAsync(Guid userUuid, Guid trackUuid, CancellationToken ct = default) =>
        await repo.RemoveFavoriteAsync(userUuid, trackUuid, ct);

    private async Task<MusicPlaylistDetailDto?> GetSystemPlaylistAsync(Guid userUuid, string playlistId, CancellationToken ct)
    {
        if (playlistId == SystemPlaylistIds.UploadedPersonal)
        {
            var tracks = await repo.ListPersonalTracksAsync(userUuid, ct);
            var trackDtos = await trackMapper.MapTracksAsync(tracks, ct);
            return new MusicPlaylistDetailDto(
                playlistId,
                "Загруженное для себя",
                tracks.Count,
                MusicPlaylistKindDto.System,
                "uploaded-personal",
                false,
                null,
                trackDtos);
        }

        if (playlistId == SystemPlaylistIds.UploadedPlatform)
        {
            var tracks = await repo.ListPlatformTracksAsync(userUuid, ct);
            var trackDtos = await trackMapper.MapTracksAsync(tracks, ct);
            return new MusicPlaylistDetailDto(
                playlistId,
                "Загруженное на площадку",
                tracks.Count,
                MusicPlaylistKindDto.System,
                "uploaded-platform",
                false,
                null,
                trackDtos);
        }

        return null;
    }

    private static string NormalizePlaylistTitle(string title)
    {
        var normalized = (title ?? string.Empty).Trim();
        if (normalized.Length == 0)
            throw new MusicPlaylistValidationException("Введите название плейлиста.");
        if (normalized.Length > 200)
            throw new MusicPlaylistValidationException("Название плейлиста слишком длинное.");
        return normalized;
    }

}
