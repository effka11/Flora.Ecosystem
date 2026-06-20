using Flora.Music.Domain;

namespace Flora.Music.Application.Artists;

public sealed record TrackArtistCreditInput(Guid ArtistUuid, TrackArtistJoiner JoinerBefore);

public sealed record ResolvedTrackArtistCredit(
    Guid ArtistUuid,
    string DisplayName,
    TrackArtistRole Role,
    TrackArtistJoiner JoinerBefore,
    int SortOrder);
