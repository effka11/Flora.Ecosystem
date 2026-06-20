using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Flora.Content.Application.Videos;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Webp;
using SixLabors.ImageSharp.Processing;

namespace Flora.Content.Infrastructure;

/// <summary>
/// Транскодер на внешнем ffmpeg: видео → AV1 (SVT-AV1) в MP4 c faststart, аудио → Opus,
/// постер — первый кадр в WebP (тот же пайплайн качества, что у фото постов).
/// </summary>
public sealed class FfmpegVideoTranscoder : IVideoTranscoder
{
    /// <summary>Длинная сторона ≤ 1920 (1080p-класс), без апскейла, размеры чётные.</summary>
    private const int MaxLongSide = 1920;
    /// <summary>CRF 32 на preset 7 — визуально прозрачно для UGC при ~3–5x меньшем размере, чем H.264.</summary>
    private const int SvtCrf = 32;
    private const int SvtPreset = 7;
    private const int PosterMaxDimension = 1280;
    private const int PosterWebpQuality = 82;

    private static readonly WebpEncoder PosterEncoder = new()
    {
        Quality = PosterWebpQuality,
        FileFormat = WebpFileFormatType.Lossy,
    };

    private readonly MediaTranscodingOptions _options;
    private readonly ILogger<FfmpegVideoTranscoder> _logger;
    private bool? _available;

    public FfmpegVideoTranscoder(IOptions<MediaTranscodingOptions> options, ILogger<FfmpegVideoTranscoder> logger)
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
            _available = code == 0 && stdout.Contains("libsvtav1", StringComparison.OrdinalIgnoreCase);
            if (_available == false)
                _logger.LogWarning("ffmpeg найден, но без энкодера libsvtav1 — загрузка видео постов недоступна.");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "ffmpeg недоступен по пути '{Path}' — загрузка видео постов недоступна.", FfmpegPath);
            _available = false;
        }
        return _available.Value;
    }

    public async Task<VideoProbeResult> ProbeAsync(string inputPath, CancellationToken ct = default)
    {
        var (code, stdout, stderr) = await RunAsync(FfprobePath,
        [
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-show_entries", "format=duration",
            "-of", "json",
            inputPath,
        ], ct);
        if (code != 0)
            throw new InvalidOperationException($"ffprobe завершился с кодом {code}: {Tail(stderr)}");

        using var doc = JsonDocument.Parse(stdout);
        var root = doc.RootElement;
        if (!root.TryGetProperty("streams", out var streams) || streams.GetArrayLength() == 0)
            throw new InvalidOperationException("В файле нет видеопотока.");
        var stream = streams[0];
        var width = stream.TryGetProperty("width", out var w) ? w.GetInt32() : 0;
        var height = stream.TryGetProperty("height", out var h) ? h.GetInt32() : 0;
        var durationMs = 0;
        if (root.TryGetProperty("format", out var format) &&
            format.TryGetProperty("duration", out var dur) &&
            double.TryParse(dur.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds))
        {
            durationMs = (int)Math.Round(seconds * 1000);
        }
        if (width <= 0 || height <= 0)
            throw new InvalidOperationException("Не удалось определить размеры видео.");
        return new VideoProbeResult(width, height, durationMs);
    }

    public async Task<VideoTranscodeResult> TranscodeAsync(string inputPath, CancellationToken ct = default)
    {
        var outPath = Path.Combine(Path.GetTempPath(), $"flora-video-{Guid.NewGuid():N}.mp4");
        var posterPath = Path.Combine(Path.GetTempPath(), $"flora-poster-{Guid.NewGuid():N}.png");
        try
        {
            // Кавычки внутри -vf обрабатывает парсер фильтров ffmpeg (аргументы передаются без shell).
            var scaleFactor = $"min(1,min({MaxLongSide}/iw,{MaxLongSide}/ih))";
            var scale = $"scale='trunc(iw*{scaleFactor}/2)*2':'trunc(ih*{scaleFactor}/2)*2'";
            var (code, _, stderr) = await RunAsync(FfmpegPath,
            [
                "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
                "-i", inputPath,
                "-map_metadata", "-1",
                "-vf", scale,
                "-c:v", "libsvtav1",
                "-preset", SvtPreset.ToString(CultureInfo.InvariantCulture),
                "-crf", SvtCrf.ToString(CultureInfo.InvariantCulture),
                "-pix_fmt", "yuv420p",
                "-c:a", "libopus", "-b:a", "96k",
                "-movflags", "+faststart",
                outPath,
            ], ct, TranscodeTimeoutSeconds);
            if (code != 0)
                throw new InvalidOperationException($"ffmpeg завершился с кодом {code}: {Tail(stderr)}");

            var probe = await ProbeAsync(outPath, ct);

            var posterAtSec = Math.Min(0.5, probe.DurationMs / 2000.0);
            var (posterCode, _, posterStderr) = await RunAsync(FfmpegPath,
            [
                "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
                "-ss", posterAtSec.ToString("0.###", CultureInfo.InvariantCulture),
                "-i", outPath,
                "-frames:v", "1",
                posterPath,
            ], ct);
            if (posterCode != 0)
                throw new InvalidOperationException($"ffmpeg (постер) завершился с кодом {posterCode}: {Tail(posterStderr)}");

            var (posterData, posterContentType) = await EncodePosterWebpAsync(posterPath, ct);
            var videoData = await File.ReadAllBytesAsync(outPath, ct);

            byte[]? h264Data = null;
            var h264Out = Path.Combine(Path.GetTempPath(), $"flora-video-h264-{Guid.NewGuid():N}.mp4");
            try
            {
                var h264ScaleFactor = $"min(1,min({MaxLongSide}/iw,{MaxLongSide}/ih))";
                var h264Scale = $"scale='trunc(iw*{h264ScaleFactor}/2)*2':'trunc(ih*{h264ScaleFactor}/2)*2'";
                var (h264Code, _, h264Err) = await RunAsync(FfmpegPath,
                [
                    "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
                    "-i", inputPath,
                    "-map_metadata", "-1",
                    "-vf", h264Scale,
                    "-c:v", "libx264",
                    "-preset", "veryfast",
                    "-crf", "28",
                    "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "128k",
                    "-movflags", "+faststart",
                    h264Out,
                ], ct, TranscodeTimeoutSeconds);
                if (h264Code == 0)
                    h264Data = await File.ReadAllBytesAsync(h264Out, ct);
                else
                    _logger.LogWarning("H.264 compatibility renditions skipped: {Err}", Tail(h264Err));
            }
            finally
            {
                TryDelete(h264Out);
            }

            return new VideoTranscodeResult(
                videoData,
                "video/mp4",
                posterData,
                posterContentType,
                probe.Width,
                probe.Height,
                probe.DurationMs,
                h264Data,
                h264Data is not null ? "video/mp4" : null);
        }
        finally
        {
            TryDelete(outPath);
            TryDelete(posterPath);
        }
    }

    private static async Task<(byte[] Data, string ContentType)> EncodePosterWebpAsync(string posterPngPath, CancellationToken ct)
    {
        using var image = await Image.LoadAsync(posterPngPath, ct);
        if (image.Width > PosterMaxDimension || image.Height > PosterMaxDimension)
        {
            image.Mutate(x => x.Resize(new ResizeOptions
            {
                Mode = ResizeMode.Max,
                Size = new Size(PosterMaxDimension, PosterMaxDimension),
                Sampler = KnownResamplers.Lanczos3,
            }));
        }
        using var ms = new MemoryStream();
        await image.SaveAsync(ms, PosterEncoder, ct);
        return (ms.ToArray(), "image/webp");
    }

    /// <summary>Default wall-clock cap for fast ffprobe/`-encoders` calls.</summary>
    private const int DefaultProcessTimeoutSeconds = 90;
    /// <summary>Wall-clock cap for an actual transcode pass (AV1 + H.264 fallback) to bound a hostile or pathological input.</summary>
    private const int TranscodeTimeoutSeconds = 600;

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
            try { process.Kill(entireProcessTree: true); } catch { /* процесс уже завершился */ }
            if (!ct.IsCancellationRequested)
                throw new TimeoutException($"Процесс '{fileName}' превысил лимит времени.");
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
            if (File.Exists(path)) File.Delete(path);
        }
        catch { /* temp-файл удалится сборщиком ОС */ }
    }
}
