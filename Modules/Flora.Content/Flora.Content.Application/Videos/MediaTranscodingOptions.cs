namespace Flora.Content.Application.Videos;

/// <summary>Конфигурация секции "Media": пути к ffmpeg/ffprobe (по умолчанию ищутся в PATH).</summary>
public sealed class MediaTranscodingOptions
{
    public const string SectionName = "Media";

    public string FfmpegPath { get; set; } = "ffmpeg";

    /// <summary>Если не задан, выводится из FfmpegPath (тот же каталог) либо берётся "ffprobe" из PATH.</summary>
    public string? FfprobePath { get; set; }
}
