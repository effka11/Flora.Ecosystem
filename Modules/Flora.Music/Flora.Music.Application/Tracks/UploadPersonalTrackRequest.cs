using Flora.Music.Application.Artists;

namespace Flora.Music.Application.Tracks;

public sealed record UploadPersonalTrackRequest(
    Guid OwnerUserUuid,
    string Title,
    string? ArtistDisplay,
    IReadOnlyList<TrackArtistCreditInput> ArtistCredits,
    string? Tags,
    string? CoverColorId,
    string? TrackKindId,
    int DurationMs,
    string ContentType,
    string? FileName,
    byte[] AudioBytes);
