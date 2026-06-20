using Flora.Shared;

namespace Flora.Music.Domain;

public class MusicTrackArtist
{
    public Guid MusicTrackArtistUuid { get; set; } = FloraUuid.NewGuid();
    public Guid TrackUuid { get; set; }
    public Guid ArtistUuid { get; set; }
    public TrackArtistRole Role { get; set; }
    public TrackArtistJoiner JoinerBefore { get; set; }
    public int SortOrder { get; set; }

    public MusicTrack? Track { get; set; }
    public MusicArtist? Artist { get; set; }
}
