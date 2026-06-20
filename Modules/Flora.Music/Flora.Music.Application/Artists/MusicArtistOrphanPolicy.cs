namespace Flora.Music.Application.Artists;

public static class MusicArtistOrphanPolicy
{
    public static readonly TimeSpan OrphanTtl = TimeSpan.FromHours(1);
}
