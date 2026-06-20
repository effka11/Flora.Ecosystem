using Flora.Music.Contracts;

namespace Flora.Music.Application.Tracks;

public interface IMusicTrackService
{
    Task<UploadMusicTrackResultDto> UploadPersonalAsync(UploadPersonalTrackRequest request, CancellationToken ct = default);
    Task<UploadMusicTrackResultDto> UploadPlatformAsync(UploadPlatformTrackRequest request, CancellationToken ct = default);
    Task<MusicLibraryDto> ListLibraryAsync(Guid ownerUserUuid, CancellationToken ct = default);
    Task<MusicPlatformCatalogDto> ListPlatformCatalogAsync(Guid requesterUserUuid, CancellationToken ct = default);
    Task<bool> DeleteAsync(Guid ownerUserUuid, Guid trackUuid, CancellationToken ct = default);
    Task<MusicTrackStreamInfo?> GetAudioForOwnerAsync(Guid ownerUserUuid, Guid trackUuid, CancellationToken ct = default);
    Task<MusicCoverStreamInfo?> GetCoverForOwnerAsync(Guid ownerUserUuid, Guid trackUuid, CancellationToken ct = default);
}

public sealed record MusicTrackStreamInfo(byte[] Data, string ContentType);

public sealed record MusicCoverStreamInfo(byte[] Data, string ContentType);
