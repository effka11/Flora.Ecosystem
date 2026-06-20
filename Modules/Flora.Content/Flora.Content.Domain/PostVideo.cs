using Flora.Shared;

namespace Flora.Content.Domain;

public enum PostVideoStatus
{
    Processing = 0,
    Ready = 1,
    Failed = 2,
}

/// <summary>Видео поста: оригинал транскодируется в AV1 (MP4) фоновым воркером, до готовности Data пуст.</summary>
public class PostVideo
{
    public Guid Uuid { get; set; } = FloraUuid.NewGuid();
    public Guid PostUuid { get; set; }
    public PostVideoStatus Status { get; set; } = PostVideoStatus.Processing;
    public string ContentType { get; set; } = "video/mp4";
    public byte[] Data { get; set; } = Array.Empty<byte>();
    /// <summary>H.264 MP4 для iOS/legacy-клиентов; AV1 остаётся в Data.</summary>
    public byte[]? CompatibilityData { get; set; }
    public string? CompatibilityContentType { get; set; }
    public byte[] PosterData { get; set; } = Array.Empty<byte>();
    public string PosterContentType { get; set; } = "image/avif";
    public int Width { get; set; }
    public int Height { get; set; }
    public int DurationMs { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
