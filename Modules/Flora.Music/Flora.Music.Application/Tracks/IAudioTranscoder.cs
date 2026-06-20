namespace Flora.Music.Application.Tracks;

public interface IAudioTranscoder
{
    Task<bool> IsAvailableAsync(CancellationToken ct = default);

    Task<MusicAudioPrepareResult> PrepareMusicAudioAsync(
        byte[] inputBytes,
        string? contentTypeHint,
        string? fileNameHint,
        CancellationToken ct = default);
}

public sealed record MusicAudioPrepareResult(
    byte[] Data,
    string ContentType,
    int DurationMs,
    bool WasTranscoded,
    bool KeptOriginalBecauseSmaller);

public sealed class MusicAudioTranscoderUnavailableException(string message) : Exception(message);
