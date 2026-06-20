using Flora.Shared;

namespace Flora.Music.Domain;

public class MusicTrack
{
    public Guid TrackUuid { get; set; } = FloraUuid.NewGuid();
    public Guid OwnerUserUuid { get; set; }
    public TrackScope Scope { get; set; }

    public string Title { get; set; } = string.Empty;
    public string ArtistDisplay { get; set; } = string.Empty;
    public string? Tags { get; set; }

    public string? GenreId { get; set; }
    public string? LicenseId { get; set; }

    public string? CoverColorId { get; set; }
    public string? TrackKindId { get; set; }
    public byte[]? CoverData { get; set; }
    public string? CoverContentType { get; set; }

    public string ContentType { get; set; } = "audio/mpeg";
    public byte[] AudioData { get; set; } = [];
    public int DurationMs { get; set; }
    public long FileSizeBytes { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    /// <summary>Площадка: момент публикации; null — личный трек или ещё не опубликован.</summary>
    public DateTime? PublishedAt { get; set; }
}
