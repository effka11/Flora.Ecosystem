using System.Security.Claims;
using Flora.Music.Application.Artists;
using Flora.Music.Application.Playlists;
using Flora.Music.Application.Tracks;
using Flora.Music.Contracts;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Flora.Music;

[ApiController]
[Route("api/music")]
[Authorize]
public sealed class MusicController(
    IMusicTrackService tracks,
    IMusicPlaylistService playlists,
    IMusicRecommendationService recommendations,
    IMusicGenreService genres,
    IMusicArtistService artists) : ControllerBase
{
    private const long MaxAudioBytes = MusicUploadValidation.MaxAudioBytes;
    private const long MaxCoverBytes = MusicUploadValidation.MaxCoverBytes;

    private bool TryGetCurrentUser(out Guid userUuid)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (!string.IsNullOrEmpty(sub) && Guid.TryParse(sub, out userUuid))
            return true;
        userUuid = Guid.Empty;
        return false;
    }

    [HttpGet("artists")]
    public async Task<IActionResult> GetArtists([FromQuery] int take = 20, CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out _))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var list = await artists.ListFeaturedAsync(take, ct);
        return Ok(list.Select(MusicArtistControllerHelpers.MapArtistSummary));
    }

    [HttpGet("artists/search")]
    public async Task<IActionResult> SearchArtists(
        [FromQuery] string? q,
        [FromQuery] int limit = 10,
        CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out _))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        try
        {
            var list = await artists.SearchAsync(q ?? string.Empty, limit, ct);
            return Ok(list.Select(MusicArtistControllerHelpers.MapArtistSummary));
        }
        catch (MusicArtistValidationException ex)
        {
            return BadRequest(new { error = ex.Message });
        }
    }

    [HttpGet("artists/{artistUuid:guid}")]
    public async Task<IActionResult> GetArtist(Guid artistUuid, CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out _))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var artist = await artists.GetAsync(artistUuid, ct);
        if (artist == null)
            return NotFound(new { error = "Исполнитель не найден." });

        return Ok(MusicArtistControllerHelpers.MapArtistDetail(artist));
    }

    [HttpGet("artists/{artistUuid:guid}/cover")]
    public async Task<IActionResult> GetArtistCover(Guid artistUuid, CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out _))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var cover = await artists.GetCoverAsync(artistUuid, ct);
        if (cover == null)
            return NotFound(new { error = "Обложка не найдена." });

        return File(cover.Data, cover.ContentType);
    }

    [HttpGet("artists/{artistUuid:guid}/tracks")]
    public async Task<IActionResult> GetArtistTracks(
        Guid artistUuid,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 50,
        CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var result = await artists.GetArtistTracksAsync(artistUuid, userUuid, page, pageSize, ct);
        if (result == null)
            return NotFound(new { error = "Исполнитель не найден." });

        return Ok(new
        {
            tracks = result.Tracks.Select(MapGenreTrack),
            totalCount = result.TotalCount,
            page = result.Page,
            pageSize = result.PageSize,
        });
    }

    [HttpPost("artists")]
    [RequestSizeLimit(MaxCoverBytes + 1024 * 1024)]
    public async Task<IActionResult> CreateArtist(CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        try
        {
            byte[]? coverBytes = null;
            string? coverContentType = null;
            var form = await Request.ReadFormAsync(ct);
            var cover = form.Files.GetFile("cover");
            if (cover is { Length: > 0 })
            {
                coverContentType = MusicUploadValidation.NormalizeContentType(cover.ContentType);
                var coverError = MusicUploadValidation.ValidateCover(coverContentType, cover.Length);
                if (coverError != null)
                    return BadRequest(new { error = coverError });

                await using var stream = cover.OpenReadStream();
                using var ms = new MemoryStream();
                await stream.CopyToAsync(ms, ct);
                coverBytes = ms.ToArray();
            }

            var displayName = form["displayName"].FirstOrDefault() ?? string.Empty;
            var linkRaw = form["linkToMyProfile"].FirstOrDefault();
            _ = bool.TryParse(linkRaw, out var linkToMyProfile);

            var result = await artists.CreateAsync(
                new CreateMusicArtistRequest(displayName, linkToMyProfile, coverBytes, coverContentType),
                userUuid,
                ct);
            return Ok(new
            {
                artistUuid = result.ArtistUuid,
                displayName = result.DisplayName,
                linkedUserUuid = linkToMyProfile ? userUuid : (Guid?)null,
                createdByUserUuid = userUuid,
                tracksCount = 0,
                hasCoverImage = result.HasCoverImage,
            });
        }
        catch (MusicArtistValidationException ex)
        {
            return BadRequest(new { error = ex.Message });
        }
    }

    [HttpPost("tracks/self")]
    [RequestSizeLimit(MaxAudioBytes + 1024 * 1024)]
    public async Task<IActionResult> UploadPersonalTrack(
        [FromForm] string? title,
        [FromForm] string? artist,
        [FromForm] string? artistCredits,
        [FromForm] string? tags,
        [FromForm] string? coverColorId,
        [FromForm] string? trackKindId,
        [FromForm] int durationMs,
        [FromForm] IFormFile? file,
        CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        if (file == null || file.Length <= 0)
            return BadRequest(new { error = "Файл пуст." });

        var contentType = MusicUploadValidation.NormalizeContentType(file.ContentType);
        var audioError = MusicUploadValidation.ValidateAudio(contentType, file.FileName, file.Length);
        if (audioError != null)
            return BadRequest(new { error = audioError });

        await using var stream = file.OpenReadStream();
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms, ct);

        try
        {
            var result = await tracks.UploadPersonalAsync(new UploadPersonalTrackRequest(
                userUuid,
                title ?? string.Empty,
                artist,
                MusicArtistControllerHelpers.ParseArtistCredits(artistCredits),
                tags,
                coverColorId,
                trackKindId,
                durationMs,
                string.IsNullOrWhiteSpace(contentType) ? "audio/mpeg" : contentType,
                file.FileName,
                ms.ToArray()), ct);

            return Ok(new
            {
                trackUuid = result.TrackUuid,
                title = result.Title,
                artistDisplay = result.ArtistDisplay,
            });
        }
        catch (MusicAudioTranscoderUnavailableException ex)
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new { error = ex.Message });
        }
        catch (MusicTrackValidationException ex)
        {
            return BadRequest(new { error = ex.Message });
        }
        catch (MusicArtistValidationException ex)
        {
            return BadRequest(new { error = ex.Message });
        }
    }

    [HttpPost("tracks/platform")]
    [RequestSizeLimit(MaxAudioBytes + MaxCoverBytes + 2 * 1024 * 1024)]
    public async Task<IActionResult> UploadPlatformTrack(
        [FromForm] string? title,
        [FromForm] string? artist,
        [FromForm] string? artistCredits,
        [FromForm] string? genreId,
        [FromForm] string? licenseId,
        [FromForm] bool termsAccepted,
        [FromForm] int durationMs,
        [FromForm] IFormFile? file,
        [FromForm] IFormFile? cover,
        CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        if (file == null || file.Length <= 0)
            return BadRequest(new { error = "Файл пуст." });

        var contentType = MusicUploadValidation.NormalizeContentType(file.ContentType);
        var audioError = MusicUploadValidation.ValidateAudio(contentType, file.FileName, file.Length);
        if (audioError != null)
            return BadRequest(new { error = audioError });

        await using var stream = file.OpenReadStream();
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms, ct);

        byte[]? coverBytes = null;
        string? coverContentType = null;
        if (cover is { Length: > 0 })
        {
            coverContentType = MusicUploadValidation.NormalizeContentType(cover.ContentType);
            var coverError = MusicUploadValidation.ValidateCover(coverContentType, cover.Length);
            if (coverError != null)
                return BadRequest(new { error = coverError });

            await using var coverStream = cover.OpenReadStream();
            using var coverMs = new MemoryStream();
            await coverStream.CopyToAsync(coverMs, ct);
            coverBytes = coverMs.ToArray();
        }

        try
        {
            var result = await tracks.UploadPlatformAsync(new UploadPlatformTrackRequest(
                userUuid,
                title ?? string.Empty,
                artist,
                MusicArtistControllerHelpers.ParseArtistCredits(artistCredits),
                genreId ?? string.Empty,
                licenseId ?? string.Empty,
                termsAccepted,
                durationMs,
                string.IsNullOrWhiteSpace(contentType) ? "audio/mpeg" : contentType,
                file.FileName,
                ms.ToArray(),
                coverBytes,
                coverContentType), ct);

            return Ok(new
            {
                trackUuid = result.TrackUuid,
                title = result.Title,
                artistDisplay = result.ArtistDisplay,
            });
        }
        catch (MusicAudioTranscoderUnavailableException ex)
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new { error = ex.Message });
        }
        catch (MusicTrackValidationException ex)
        {
            return BadRequest(new { error = ex.Message });
        }
        catch (MusicArtistValidationException ex)
        {
            return BadRequest(new { error = ex.Message });
        }
    }

    [HttpGet("tracks/library")]
    public async Task<IActionResult> GetLibrary(CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var library = await tracks.ListLibraryAsync(userUuid, ct);
        return Ok(library.Tracks.Select(MusicTrackResponseHelpers.MapTrack));
    }

    [HttpGet("tracks/platform")]
    public async Task<IActionResult> GetPlatformCatalog(CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var catalog = await tracks.ListPlatformCatalogAsync(userUuid, ct);
        return Ok(catalog.Tracks.Select(MusicTrackResponseHelpers.MapPlatformTrack));
    }

    [HttpGet("genres")]
    public async Task<IActionResult> GetGenreCatalog(CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out _))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var catalog = await genres.GetCatalogAsync(ct);
        return Ok(new
        {
            genres = catalog.Genres.Select(MapGenre),
        });
    }

    [HttpGet("genres/{genreId}")]
    public async Task<IActionResult> GetGenrePage(
        string genreId,
        [FromQuery] string? subgenreId = null,
        CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var page = await genres.GetPageAsync(userUuid, genreId, subgenreId, ct);
        if (page == null)
            return NotFound(new { error = "Жанр не найден." });

        return Ok(new
        {
            genre = MapGenre(page.Genre),
            activeSubgenre = page.ActiveSubgenre == null ? null : MapSubgenre(page.ActiveSubgenre),
            collections = page.Collections.Select(c => new
            {
                id = c.Id,
                title = c.Title,
                tracks = c.Tracks.Select(MapGenreTrack),
            }),
        });
    }

    [HttpGet("flow")]
    public async Task<IActionResult> GetFlowWave(
        [FromQuery] int take = 20,
        [FromQuery] Guid[]? exclude = null,
        [FromQuery] string? genreId = null,
        [FromQuery] string? subgenreId = null,
        CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var wave = await recommendations.GetFlowWaveAsync(
            userUuid,
            new MusicFlowWaveRequest(take, exclude, genreId, subgenreId),
            ct);

        return Ok(new
        {
            tracks = wave.Tracks.Select(MusicTrackResponseHelpers.MapFlowTrack),
            generatedAt = wave.GeneratedAt,
            expiresAt = wave.ExpiresAt,
        });
    }

    [HttpGet("tracks/{trackUuid:guid}/audio")]
    public async Task<IActionResult> GetTrackAudio(Guid trackUuid, CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var audio = await tracks.GetAudioForOwnerAsync(userUuid, trackUuid, ct);
        if (audio == null)
            return NotFound(new { error = "Трек не найден." });

        return File(audio.Data, audio.ContentType, enableRangeProcessing: true);
    }

    [HttpGet("tracks/{trackUuid:guid}/cover")]
    public async Task<IActionResult> GetTrackCover(Guid trackUuid, CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var cover = await tracks.GetCoverForOwnerAsync(userUuid, trackUuid, ct);
        if (cover == null)
            return NotFound();

        return File(cover.Data, cover.ContentType);
    }

    [HttpDelete("tracks/{trackUuid:guid}")]
    public async Task<IActionResult> DeleteTrack(Guid trackUuid, CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var deleted = await tracks.DeleteAsync(userUuid, trackUuid, ct);
        if (!deleted)
            return NotFound(new { error = "Трек не найден." });

        return NoContent();
    }

    [HttpGet("playlists")]
    public async Task<IActionResult> GetPlaylists(CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var result = await playlists.ListPlaylistsAsync(userUuid, ct);
        return Ok(result.Playlists.Select(MapPlaylistSummary));
    }

    [HttpGet("playlists/{playlistId}")]
    public async Task<IActionResult> GetPlaylist(string playlistId, CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var playlist = await playlists.GetPlaylistAsync(userUuid, playlistId, ct);
        if (playlist == null)
            return NotFound(new { error = "Плейлист не найден." });

        return Ok(MapPlaylistDetail(playlist));
    }

    [HttpPost("playlists")]
    public async Task<IActionResult> CreatePlaylist([FromBody] CreateMusicPlaylistBody? body, CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        try
        {
            var result = await playlists.CreatePlaylistAsync(userUuid, body?.Title ?? string.Empty, ct);
            return Ok(new { playlistId = result.PlaylistId, title = result.Title });
        }
        catch (MusicPlaylistValidationException ex)
        {
            return BadRequest(new { error = ex.Message });
        }
    }

    [HttpDelete("playlists/{playlistId}")]
    public async Task<IActionResult> DeletePlaylist(string playlistId, CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        try
        {
            var deleted = await playlists.DeletePlaylistAsync(userUuid, playlistId, ct);
            if (!deleted)
                return NotFound(new { error = "Плейлист не найден." });
            return NoContent();
        }
        catch (MusicPlaylistForbiddenException ex)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new { error = ex.Message });
        }
    }

    [HttpPost("tracks/{trackUuid:guid}/favorite")]
    public async Task<IActionResult> AddFavorite(Guid trackUuid, CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var added = await playlists.AddFavoriteAsync(userUuid, trackUuid, ct);
        if (!added)
            return NotFound(new { error = "Трек не найден." });

        return NoContent();
    }

    [HttpDelete("tracks/{trackUuid:guid}/favorite")]
    public async Task<IActionResult> RemoveFavorite(Guid trackUuid, CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var removed = await playlists.RemoveFavoriteAsync(userUuid, trackUuid, ct);
        if (!removed)
            return NotFound(new { error = "Трек не в избранном." });

        return NoContent();
    }

    private static object MapGenre(MusicGenreDto genre) => new
    {
        id = genre.Id,
        title = genre.Title,
        description = genre.Description,
        trackCount = genre.TrackCount,
        subgenres = genre.Subgenres.Select(MapSubgenre),
    };

    private static object MapSubgenre(MusicSubgenreDto subgenre) => new
    {
        id = subgenre.Id,
        title = subgenre.Title,
        description = subgenre.Description,
        trackCount = subgenre.TrackCount,
    };

    private static object MapGenreTrack(MusicTrackDto track) => MusicTrackResponseHelpers.MapTrack(track);

    private static object MapPlaylistSummary(MusicPlaylistSummaryDto playlist) => new
    {
        id = playlist.Id,
        title = playlist.Title,
        trackCount = playlist.TrackCount,
        kind = playlist.Kind == MusicPlaylistKindDto.System ? "system" : "user",
        variant = playlist.Variant,
        canDelete = playlist.CanDelete,
        coverColorId = playlist.CoverColorId,
    };

    private static object MapPlaylistDetail(MusicPlaylistDetailDto playlist) => new
    {
        id = playlist.Id,
        title = playlist.Title,
        trackCount = playlist.TrackCount,
        kind = playlist.Kind == MusicPlaylistKindDto.System ? "system" : "user",
        variant = playlist.Variant,
        canDelete = playlist.CanDelete,
        coverColorId = playlist.CoverColorId,
        tracks = playlist.Tracks.Select(MusicTrackResponseHelpers.MapTrack),
    };

}

public sealed record CreateMusicPlaylistBody(string? Title);
