using Flora.Music.Application.Artists;

namespace Flora.Music.Application.Tracks;

public sealed record UploadPlatformTrackRequest(
    Guid OwnerUserUuid,
    string Title,
    string? ArtistDisplay,
    IReadOnlyList<TrackArtistCreditInput> ArtistCredits,
    string GenreId,
    string LicenseId,
    bool TermsAccepted,
    int DurationMs,
    string ContentType,
    string? FileName,
    byte[] AudioBytes,
    byte[]? CoverBytes,
    string? CoverContentType);
