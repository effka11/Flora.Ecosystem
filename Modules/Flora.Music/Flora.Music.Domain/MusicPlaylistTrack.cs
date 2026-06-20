namespace Flora.Music.Domain;

public class MusicPlaylistTrack
{
    public Guid PlaylistUuid { get; set; }
    public Guid TrackUuid { get; set; }
    public int Position { get; set; }
    public DateTime AddedAt { get; set; } = DateTime.UtcNow;

    public MusicPlaylist? Playlist { get; set; }
    public MusicTrack? Track { get; set; }
}
