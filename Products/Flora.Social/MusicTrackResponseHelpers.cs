using Flora.Music.Contracts;

namespace Flora.Social;

internal static class MusicTrackResponseHelpers
{
    public static object MapTrack(MusicTrackDto track) => new
    {
        trackUuid = track.TrackUuid,
        scope = track.Scope == MusicTrackScopeDto.Platform ? "platform" : "personal",
        title = track.Title,
        artistDisplay = track.ArtistDisplay,
        artistCredits = MapArtistCredits(track.ArtistCredits),
        tags = track.Tags,
        genreId = track.GenreId,
        licenseId = track.LicenseId,
        coverColorId = track.CoverColorId,
        trackKindId = track.TrackKindId,
        hasCoverImage = track.HasCoverImage,
        durationMs = track.DurationMs,
        createdAt = track.CreatedAt,
        publishedAt = track.PublishedAt,
    };

    public static object MapPlatformTrack(MusicPlatformTrackDto track) => new
    {
        trackUuid = track.TrackUuid,
        title = track.Title,
        artistDisplay = track.ArtistDisplay,
        artistCredits = MapArtistCredits(track.ArtistCredits),
        genreId = track.GenreId,
        licenseId = track.LicenseId,
        coverColorId = track.CoverColorId,
        trackKindId = track.TrackKindId,
        hasCoverImage = track.HasCoverImage,
        durationMs = track.DurationMs,
        createdAt = track.CreatedAt,
        publishedAt = track.PublishedAt,
        isOwnedByCurrentUser = track.IsOwnedByCurrentUser,
    };

    public static object MapFlowTrack(MusicFlowTrackDto track) => new
    {
        trackUuid = track.TrackUuid,
        title = track.Title,
        artistDisplay = track.ArtistDisplay,
        artistCredits = MapArtistCredits(track.ArtistCredits),
        genreId = track.GenreId,
        licenseId = track.LicenseId,
        coverColorId = track.CoverColorId,
        trackKindId = track.TrackKindId,
        hasCoverImage = track.HasCoverImage,
        durationMs = track.DurationMs,
        createdAt = track.CreatedAt,
        publishedAt = track.PublishedAt,
        isOwnedByCurrentUser = track.IsOwnedByCurrentUser,
    };

    private static IEnumerable<object> MapArtistCredits(IReadOnlyList<TrackArtistCreditDto> credits) =>
        credits.Select(c => new
        {
            artistUuid = c.ArtistUuid,
            displayName = c.DisplayName,
            joinerBefore = c.JoinerBefore.ToString(),
        });
}
