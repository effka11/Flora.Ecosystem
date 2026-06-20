using Flora.Music.Application.Artists;
using Flora.Music.Contracts;
using Flora.Music.Domain;

namespace Flora.Music.Application.Tracks;

public sealed class MusicTrackService(
    IMusicTrackRepository repo,
    IAudioTranscoder audioTranscoder,
    MusicArtistTrackAttachService artistAttach,
    MusicArtistObsoleteFallback obsoleteFallback,
    IMusicArtistRepository artistRepo,
    MusicTrackDtoMapper trackMapper) : IMusicTrackService
{
    public async Task<UploadMusicTrackResultDto> UploadPersonalAsync(UploadPersonalTrackRequest request, CancellationToken ct = default)
    {
        var audioError = MusicUploadValidation.ValidateAudio(
            request.ContentType, request.FileName, request.AudioBytes.LongLength);
        if (audioError != null)
            throw new MusicTrackValidationException(audioError);

        var prepared = await audioTranscoder.PrepareMusicAudioAsync(
            request.AudioBytes, request.ContentType, request.FileName, ct);

        var trackUuid = Flora.Shared.FloraUuid.NewGuid();
        IReadOnlyList<MusicTrackArtist>? preparedCredits = null;
        string artistDisplay;

        if (request.ArtistCredits.Count > 0)
        {
            var (display, credits) = await artistAttach.PrepareCreditsAsync(trackUuid, request.ArtistCredits, ct);
            artistDisplay = display;
            preparedCredits = credits;
        }
        else
        {
            var name = request.ArtistDisplay?.Trim() ?? string.Empty;
            if (!MusicArtistNameNormalizer.IsValidDisplayName(name))
                throw new MusicArtistValidationException("Укажите исполнителя.");
            artistDisplay = name;
        }

        var track = new MusicTrack
        {
            TrackUuid = trackUuid,
            OwnerUserUuid = request.OwnerUserUuid,
            Scope = TrackScope.Personal,
            Title = MusicUploadValidation.NormalizeTitle(request.Title),
            ArtistDisplay = artistDisplay,
            Tags = string.IsNullOrWhiteSpace(request.Tags) ? null : request.Tags.Trim(),
            CoverColorId = string.IsNullOrWhiteSpace(request.CoverColorId) ? "forest" : request.CoverColorId.Trim(),
            TrackKindId = string.IsNullOrWhiteSpace(request.TrackKindId) ? "song" : request.TrackKindId.Trim(),
            ContentType = prepared.ContentType,
            AudioData = prepared.Data,
            DurationMs = prepared.DurationMs > 0 ? prepared.DurationMs : Math.Max(0, request.DurationMs),
            FileSizeBytes = prepared.Data.LongLength,
        };

        await repo.AddAsync(track, ct);
        if (preparedCredits is { Count: > 0 })
            await artistAttach.AttachPreparedCreditsAsync(preparedCredits, ct);
        return new UploadMusicTrackResultDto(track.TrackUuid, track.Title, track.ArtistDisplay);
    }

    public async Task<UploadMusicTrackResultDto> UploadPlatformAsync(UploadPlatformTrackRequest request, CancellationToken ct = default)
    {
        if (!request.TermsAccepted)
            throw new MusicTrackValidationException("Примите условия пользовательского соглашения.");

        var audioError = MusicUploadValidation.ValidateAudio(
            request.ContentType, request.FileName, request.AudioBytes.LongLength);
        if (audioError != null)
            throw new MusicTrackValidationException(audioError);

        if (string.IsNullOrWhiteSpace(request.GenreId))
            throw new MusicTrackValidationException("Выберите жанр.");

        var licenseError = MusicUploadValidation.ValidateLicenseId(request.LicenseId);
        if (licenseError != null)
            throw new MusicTrackValidationException(licenseError);

        byte[]? coverData = null;
        string? coverContentType = null;
        if (request.CoverBytes is { Length: > 0 })
        {
            var coverError = MusicUploadValidation.ValidateCover(request.CoverContentType, request.CoverBytes.LongLength);
            if (coverError != null)
                throw new MusicTrackValidationException(coverError);
            coverData = request.CoverBytes;
            coverContentType = MusicUploadValidation.NormalizeContentType(request.CoverContentType);
        }

        var prepared = await audioTranscoder.PrepareMusicAudioAsync(
            request.AudioBytes, request.ContentType, request.FileName, ct);

        var credits = await obsoleteFallback.ResolveCreditsAsync(
            request.ArtistCredits, request.ArtistDisplay, request.OwnerUserUuid, ct);

        var trackUuid = Flora.Shared.FloraUuid.NewGuid();
        var (artistDisplay, preparedCredits) = await artistAttach.PrepareCreditsAsync(trackUuid, credits, ct);

        var track = new MusicTrack
        {
            TrackUuid = trackUuid,
            OwnerUserUuid = request.OwnerUserUuid,
            Scope = TrackScope.Platform,
            Title = MusicUploadValidation.NormalizeTitle(request.Title),
            ArtistDisplay = artistDisplay,
            GenreId = request.GenreId.Trim(),
            LicenseId = request.LicenseId.Trim(),
            ContentType = prepared.ContentType,
            AudioData = prepared.Data,
            CoverData = coverData,
            CoverContentType = coverContentType,
            DurationMs = prepared.DurationMs > 0 ? prepared.DurationMs : Math.Max(0, request.DurationMs),
            FileSizeBytes = prepared.Data.LongLength,
            PublishedAt = DateTime.UtcNow,
        };

        await repo.AddAsync(track, ct);
        await artistAttach.AttachPreparedCreditsAsync(preparedCredits, ct);
        return new UploadMusicTrackResultDto(track.TrackUuid, track.Title, track.ArtistDisplay);
    }

    public async Task<MusicLibraryDto> ListLibraryAsync(Guid ownerUserUuid, CancellationToken ct = default)
    {
        var tracks = await repo.ListByOwnerAsync(ownerUserUuid, ct);
        return new MusicLibraryDto(await trackMapper.MapTracksAsync(tracks, ct));
    }

    public async Task<MusicPlatformCatalogDto> ListPlatformCatalogAsync(Guid requesterUserUuid, CancellationToken ct = default)
    {
        var tracks = await repo.ListPublishedPlatformCatalogAsync(ct);
        return new MusicPlatformCatalogDto(await trackMapper.MapPlatformCatalogRowsAsync(tracks, requesterUserUuid, ct));
    }

    public async Task<bool> DeleteAsync(Guid ownerUserUuid, Guid trackUuid, CancellationToken ct = default)
    {
        var artistUuids = await artistRepo.ListArtistUuidsForTrackAsync(trackUuid, ct);
        var deleted = await repo.DeleteOwnedAsync(ownerUserUuid, trackUuid, ct);
        if (!deleted)
            return false;

        if (artistUuids.Count > 0)
            await artistRepo.DecrementTracksCountAsync(artistUuids, ct);

        return true;
    }

    public async Task<MusicTrackStreamInfo?> GetAudioForOwnerAsync(Guid requesterUserUuid, Guid trackUuid, CancellationToken ct = default)
    {
        var row = await repo.FindAudioAccessibleAsync(requesterUserUuid, trackUuid, ct);
        if (row == null || row.Data.Length == 0)
            return null;
        return new MusicTrackStreamInfo(row.Data, row.ContentType);
    }

    public async Task<MusicCoverStreamInfo?> GetCoverForOwnerAsync(Guid requesterUserUuid, Guid trackUuid, CancellationToken ct = default)
    {
        var row = await repo.FindCoverAccessibleAsync(requesterUserUuid, trackUuid, ct);
        if (row == null || row.Data.Length == 0)
            return null;
        return new MusicCoverStreamInfo(row.Data, row.ContentType);
    }

}

public sealed class MusicTrackValidationException(string message) : Exception(message);
