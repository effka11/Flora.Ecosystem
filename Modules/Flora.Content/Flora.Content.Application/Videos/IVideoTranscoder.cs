namespace Flora.Content.Application.Videos;

public sealed record VideoProbeResult(int Width, int Height, int DurationMs);

public sealed record VideoTranscodeResult(
    byte[] VideoData,
    string VideoContentType,
    byte[] PosterData,
    string PosterContentType,
    int Width,
    int Height,
    int DurationMs,
    byte[]? CompatibilityVideoData = null,
    string? CompatibilityVideoContentType = null);

/// <summary>Транскодирование видео поста в AV1. Реализация — в Infrastructure (ffmpeg), без бизнес-правил.</summary>
public interface IVideoTranscoder
{
    /// <summary>Доступен ли транскодер (ffmpeg с libsvtav1 найден). Кешируется на время жизни процесса.</summary>
    Task<bool> IsAvailableAsync(CancellationToken ct = default);

    /// <summary>Метаданные видеофайла (ffprobe). Бросает исключение, если файл не читается как видео.</summary>
    Task<VideoProbeResult> ProbeAsync(string inputPath, CancellationToken ct = default);

    /// <summary>Транскодировать в AV1 (MP4 + AVIF-постер). Вход не модифицируется и не удаляется.</summary>
    Task<VideoTranscodeResult> TranscodeAsync(string inputPath, CancellationToken ct = default);
}
