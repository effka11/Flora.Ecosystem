using Flora.Shared;

namespace Flora.Music.Domain;

public class MusicArtist
{
    public Guid ArtistUuid { get; set; } = FloraUuid.NewGuid();
    public string DisplayName { get; set; } = string.Empty;
    public string NormalizedDisplayName { get; set; } = string.Empty;
    public int TracksCount { get; set; }
    public Guid? LinkedUserUuid { get; set; }
    public Guid CreatedByUserUuid { get; set; }
    public byte[]? CoverData { get; set; }
    public string? CoverContentType { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
