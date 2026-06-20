using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Flora.Music.Application.Tracks;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Flora.Music.Infrastructure;

/// <summary>ffmpeg/ffprobe: AAC-LC 256k при выгоде; иначе оригинал MP3/M4A.</summary>
public sealed class FfmpegMusicAudioTranscoder : IAudioTranscoder
{
    private const int TargetMusicBitrateBps = 256_000;
    private const string OutputContentType = "audio/mp4";

    private static readonly HashSet<string> StorableCodecs = new(StringComparer.OrdinalIgnoreCase)
    {
        "mp3",
        "aac",
    };

    private readonly MusicMediaOptions _options;
    private readonly ILogger<FfmpegMusicAudioTranscoder> _logger;
    private bool? _available;

    public FfmpegMusicAudioTranscoder(IOptions<MusicMediaOptions> options, ILogger<FfmpegMusicAudioTranscoder> logger)
    {
        _options = options.Value;
        _logger = logger;
    }

    private string FfmpegPath => string.IsNullOrWhiteSpace(_options.FfmpegPath) ? "ffmpeg" : _options.FfmpegPath.Trim();

    private string FfprobePath
    {
        get
        {
            if (!string.IsNullOrWhiteSpace(_options.FfprobePath))
                return _options.FfprobePath.Trim();
            var ffmpeg = FfmpegPath;
            var dir = Path.GetDirectoryName(ffmpeg);
            if (string.IsNullOrEmpty(dir))
                return "ffprobe";
            var ext = Path.GetExtension(ffmpeg);
            return Path.Combine(dir, "ffprobe" + ext);
        }
    }

    public async Task<bool> IsAvailableAsync(CancellationToken ct = default)
    {
        if (_available.HasValue)
            return _available.Value;
        try
        {
            var (code, stdout, _) = await RunAsync(FfmpegPath, ["-hide_banner", "-encoders"], ct);
            _available = code == 0 && stdout.Contains(" aac ", StringComparison.OrdinalIgnoreCase);
            if (_available == false)
                _logger.LogWarning("ffmpeg найден, но без энкодера aac — транскод музыки недоступен.");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "ffmpeg недоступен по пути '{Path}'.", FfmpegPath);
            _available = false;
        }
        return _available.Value;
    }

    public async Task<MusicAudioPrepareResult> PrepareMusicAudioAsync(
        byte[] inputBytes,
        string? contentTypeHint,
        string? fileNameHint,
        CancellationToken ct = default)
    {
        if (inputBytes.Length == 0)
            throw new MusicTrackValidationException("Файл пуст.");

        var inputPath = Path.Combine(Path.GetTempPath(), $"flora-music-in-{Guid.NewGuid():N}{GuessExtension(fileNameHint, contentTypeHint)}");
        await File.WriteAllBytesAsync(inputPath, inputBytes, ct);
        try
        {
            var probe = await ProbeAudioAsync(inputPath, inputBytes.LongLength, ct);
            var originalContentType = ResolveOriginalContentType(contentTypeHint, fileNameHint, probe.CodecName);

            if (IsFastPathKeepOriginal(probe))
            {
                return new MusicAudioPrepareResult(
                    inputBytes,
                    originalContentType,
                    probe.DurationMs,
                    WasTranscoded: false,
                    KeptOriginalBecauseSmaller: false);
            }

            if (!await IsAvailableAsync(ct))
                throw new MusicAudioTranscoderUnavailableException(
                    "Обработка аудио временно недоступна (на сервере не настроен ffmpeg с AAC).");

            var transcoded = await TranscodeToAacLcAsync(inputPath, ct);
            if (!IsStorableCodec(probe.CodecName) || transcoded.Length < inputBytes.Length)
            {
                return new MusicAudioPrepareResult(
                    transcoded,
                    OutputContentType,
                    probe.DurationMs > 0 ? probe.DurationMs : await ProbeDurationOnlyAsync(transcoded, ct),
                    WasTranscoded: true,
                    KeptOriginalBecauseSmaller: false);
            }

            _logger.LogDebug(
                "Музыка: оригинал меньше транскода ({Original} vs {Transcoded} байт), сохраняем исходник.",
                inputBytes.Length,
                transcoded.Length);

            return new MusicAudioPrepareResult(
                inputBytes,
                originalContentType,
                probe.DurationMs,
                WasTranscoded: false,
                KeptOriginalBecauseSmaller: true);
        }
        finally
        {
            TryDelete(inputPath);
        }
    }

    private static bool IsStorableCodec(string codecName) =>
        StorableCodecs.Contains(codecName.Trim());

    private static bool IsFastPathKeepOriginal(AudioProbeResult probe) =>
        IsStorableCodec(probe.CodecName) && probe.EffectiveBitrateBps <= TargetMusicBitrateBps;

    private async Task<byte[]> TranscodeToAacLcAsync(string inputPath, CancellationToken ct)
    {
        var outPath = Path.Combine(Path.GetTempPath(), $"flora-music-out-{Guid.NewGuid():N}.m4a");
        try
        {
            var (code, _, stderr) = await RunAsync(FfmpegPath,
            [
                "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
                "-i", inputPath,
                "-vn",
                "-map_metadata", "-1",
                "-threads", "2",
                "-c:a", "aac",
                "-profile:a", "aac_low",
                "-b:a", "256k",
                "-ar", "44100",
                "-movflags", "+faststart",
                outPath,
            ], ct, TranscodeTimeoutSeconds);
            if (code != 0)
                throw new MusicTrackValidationException($"Не удалось обработать аудио: {Tail(stderr)}");

            return await File.ReadAllBytesAsync(outPath, ct);
        }
        finally
        {
            TryDelete(outPath);
        }
    }

    private async Task<AudioProbeResult> ProbeAudioAsync(string inputPath, long fileBytes, CancellationToken ct)
    {
        var (code, stdout, stderr) = await RunAsync(FfprobePath,
        [
            "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=codec_name,bit_rate",
            "-show_entries", "format=duration",
            "-of", "json",
            inputPath,
        ], ct);
        if (code != 0)
            throw new MusicTrackValidationException($"Не удалось прочитать аудио: {Tail(stderr)}");

        using var doc = JsonDocument.Parse(stdout);
        var root = doc.RootElement;
        if (!root.TryGetProperty("streams", out var streams) || streams.GetArrayLength() == 0)
            throw new MusicTrackValidationException("В файле нет аудиодорожки.");

        var stream = streams[0];
        var codecName = stream.TryGetProperty("codec_name", out var codec) ? codec.GetString() ?? "" : "";
        var bitRate = 0;
        if (stream.TryGetProperty("bit_rate", out var br) &&
            int.TryParse(br.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsedBr))
        {
            bitRate = parsedBr;
        }

        var durationMs = 0;
        if (root.TryGetProperty("format", out var format) &&
            format.TryGetProperty("duration", out var dur) &&
            double.TryParse(dur.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds))
        {
            durationMs = (int)Math.Round(seconds * 1000);
        }

        if (bitRate <= 0 && durationMs > 0)
            bitRate = (int)Math.Round(fileBytes * 8.0 / (durationMs / 1000.0));

        return new AudioProbeResult(codecName, bitRate, durationMs);
    }

    private async Task<int> ProbeDurationOnlyAsync(byte[] m4aBytes, CancellationToken ct)
    {
        var path = Path.Combine(Path.GetTempPath(), $"flora-music-probe-{Guid.NewGuid():N}.m4a");
        await File.WriteAllBytesAsync(path, m4aBytes, ct);
        try
        {
            var probe = await ProbeAudioAsync(path, m4aBytes.LongLength, ct);
            return probe.DurationMs;
        }
        finally
        {
            TryDelete(path);
        }
    }

    private static string ResolveOriginalContentType(string? contentTypeHint, string? fileNameHint, string codecName)
    {
        var normalized = MusicUploadValidation.NormalizeContentType(contentTypeHint);
        if (!string.IsNullOrWhiteSpace(normalized))
            return normalized;
        if (!string.IsNullOrWhiteSpace(fileNameHint) &&
            fileNameHint.EndsWith(".mp3", StringComparison.OrdinalIgnoreCase))
            return "audio/mpeg";
        if (!string.IsNullOrWhiteSpace(fileNameHint) &&
            (fileNameHint.EndsWith(".m4a", StringComparison.OrdinalIgnoreCase) ||
             fileNameHint.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase)))
            return "audio/mp4";
        return codecName.Equals("aac", StringComparison.OrdinalIgnoreCase) ? "audio/mp4" : "audio/mpeg";
    }

    private static string GuessExtension(string? fileNameHint, string? contentTypeHint)
    {
        if (!string.IsNullOrWhiteSpace(fileNameHint))
        {
            var ext = Path.GetExtension(fileNameHint);
            if (!string.IsNullOrWhiteSpace(ext))
                return ext;
        }

        var type = MusicUploadValidation.NormalizeContentType(contentTypeHint);
        return type switch
        {
            "audio/mpeg" or "audio/mp3" => ".mp3",
            "audio/mp4" or "audio/x-m4a" or "audio/m4a" => ".m4a",
            "audio/flac" => ".flac",
            "audio/wav" or "audio/x-wav" => ".wav",
            "audio/ogg" => ".ogg",
            "audio/webm" => ".webm",
            _ => ".bin",
        };
    }

    /// <summary>Default wall-clock cap for fast ffprobe/`-encoders` calls.</summary>
    private const int DefaultProcessTimeoutSeconds = 60;
    /// <summary>Wall-clock cap for an audio transcode pass to bound a hostile or pathological input.</summary>
    private const int TranscodeTimeoutSeconds = 240;

    private static async Task<(int ExitCode, string StdOut, string StdErr)> RunAsync(
        string fileName, IReadOnlyList<string> args, CancellationToken ct, int? timeoutSeconds = null)
    {
        var psi = new ProcessStartInfo
        {
            FileName = fileName,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var arg in args)
            psi.ArgumentList.Add(arg);

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException($"Не удалось запустить процесс '{fileName}'.");

        // Wall-clock timeout in addition to the caller's token: a stuck/looping ffmpeg must not pin
        // CPU/disk indefinitely. On timeout we kill the whole tree and surface a TimeoutException.
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds ?? DefaultProcessTimeoutSeconds));
        var token = timeoutCts.Token;

        var stdoutTask = process.StandardOutput.ReadToEndAsync(token);
        var stderrTask = process.StandardError.ReadToEndAsync(token);
        try
        {
            await process.WaitForExitAsync(token);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { /* ignore */ }
            if (!ct.IsCancellationRequested)
                throw new MusicTrackValidationException("Обработка аудио превысила лимит времени.");
            throw;
        }
        return (process.ExitCode, await stdoutTask, await stderrTask);
    }

    private static string Tail(string text, int max = 600)
    {
        var trimmed = text.Trim();
        return trimmed.Length <= max ? trimmed : trimmed[^max..];
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
                File.Delete(path);
        }
        catch { /* temp */ }
    }

    private sealed record AudioProbeResult(string CodecName, int EffectiveBitrateBps, int DurationMs);
}
