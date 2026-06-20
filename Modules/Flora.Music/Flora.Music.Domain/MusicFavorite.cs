namespace Flora.Music.Domain;

public class MusicFavorite
{
    public Guid UserUuid { get; set; }
    public Guid TrackUuid { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public MusicTrack? Track { get; set; }
}
