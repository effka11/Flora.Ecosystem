using Flora.Music.Application.Tracks;
using Flora.Music.Contracts;
using Flora.Music.Domain;

namespace Flora.Music.Application.Artists;

public sealed class MusicArtistService(IMusicArtistRepository repo, MusicTrackDtoMapper trackMapper) : IMusicArtistService
{
    public async Task<CreateMusicArtistResultDto> CreateAsync(
        CreateMusicArtistRequest request, Guid actorUserUuid, CancellationToken ct = default)
    {
        var displayName = request.DisplayName?.Trim() ?? string.Empty;
        if (!MusicArtistNameNormalizer.IsValidDisplayName(displayName))
            throw new MusicArtistValidationException("Укажите имя исполнителя.");

        if (request.LinkToMyProfile)
        {
            var existing = await repo.FindLinkedByUserAsync(actorUserUuid, ct);
            if (existing != null)
                throw new MusicArtistValidationException("У вас уже есть исполнитель, привязанный к профилю.");
        }

        byte[]? coverData = null;
        string? coverContentType = null;
        if (request.CoverBytes is { Length: > 0 })
        {
            var coverError = MusicUploadValidation.ValidateCover(request.CoverContentType, request.CoverBytes.LongLength);
            if (coverError != null)
                throw new MusicArtistValidationException(coverError);

            coverData = request.CoverBytes;
            coverContentType = MusicUploadValidation.NormalizeContentType(request.CoverContentType);
        }

        var artist = new MusicArtist
        {
            DisplayName = displayName,
            NormalizedDisplayName = MusicArtistNameNormalizer.Normalize(displayName),
            LinkedUserUuid = request.LinkToMyProfile ? actorUserUuid : null,
            CreatedByUserUuid = actorUserUuid,
            CoverData = coverData,
            CoverContentType = coverContentType,
        };

        await repo.AddAsync(artist, ct);
        return new CreateMusicArtistResultDto(artist.ArtistUuid, artist.DisplayName, artist.CoverData is { Length: > 0 });
    }

    public async Task<MusicArtistDetailDto?> GetAsync(Guid artistUuid, CancellationToken ct = default)
    {
        var artist = await repo.FindByUuidAsync(artistUuid, ct);
        return artist == null ? null : MapDetail(artist);
    }

    public async Task<IReadOnlyList<MusicArtistSummaryDto>> ListFeaturedAsync(int take, CancellationToken ct = default)
    {
        var artists = await repo.ListFeaturedAsync(take, ct);
        return artists.Select(MapSummary).ToList();
    }

    public async Task<IReadOnlyList<MusicArtistSummaryDto>> SearchAsync(string query, int limit, CancellationToken ct = default)
    {
        var trimmed = query?.Trim() ?? string.Empty;
        if (trimmed.Length < 1)
            throw new MusicArtistValidationException("Запрос слишком короткий.");

        var normalized = MusicArtistNameNormalizer.Normalize(trimmed);
        if (normalized.Length < 1)
            return [];

        var artists = await repo.SearchAsync(normalized, trimmed.Length, limit, ct);
        return artists.Select(MapSummary).ToList();
    }

    public async Task<PagedMusicTracksDto?> GetArtistTracksAsync(
        Guid artistUuid,
        Guid requesterUserUuid,
        int page,
        int pageSize,
        CancellationToken ct = default)
    {
        _ = requesterUserUuid;
        var artist = await repo.FindByUuidAsync(artistUuid, ct);
        if (artist == null)
            return null;

        var (tracks, total) = await repo.ListArtistTracksPagedAsync(artistUuid, requesterUserUuid, page, pageSize, ct);
        var dtos = await trackMapper.MapTracksAsync(tracks, ct);
        return new PagedMusicTracksDto(dtos, total, Math.Max(1, page), Math.Clamp(pageSize, 1, 100));
    }

    public Task RebuildTracksCountAsync(CancellationToken ct = default) =>
        repo.RebuildTracksCountAsync(ct);

    public async Task<MusicArtistCoverStreamInfo?> GetCoverAsync(Guid artistUuid, CancellationToken ct = default)
    {
        var cover = await repo.FindCoverAsync(artistUuid, ct);
        return cover == null ? null : new MusicArtistCoverStreamInfo(cover.Data, cover.ContentType);
    }

    private static MusicArtistSummaryDto MapSummary(MusicArtist artist) => new(
        artist.ArtistUuid,
        artist.DisplayName,
        artist.LinkedUserUuid,
        artist.CreatedByUserUuid,
        artist.TracksCount,
        artist.CoverData is { Length: > 0 });

    private static MusicArtistDetailDto MapDetail(MusicArtist artist) => new(
        artist.ArtistUuid,
        artist.DisplayName,
        artist.LinkedUserUuid,
        artist.CreatedByUserUuid,
        artist.TracksCount,
        artist.CoverData is { Length: > 0 });

}
