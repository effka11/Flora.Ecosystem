namespace Flora.Music.Application.Tracks;

/// <summary>Пути к ffmpeg/ffprobe (секция "Media" в appsettings, как у Flora.Content).</summary>
public sealed class MusicMediaOptions
{
    public const string SectionName = "Media";

    public string FfmpegPath { get; set; } = "ffmpeg";

    public string FfprobePath { get; set; } = "";
}
