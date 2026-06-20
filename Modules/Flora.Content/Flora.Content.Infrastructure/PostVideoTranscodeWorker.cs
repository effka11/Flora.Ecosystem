using Flora.Content.Application.Videos;
using Flora.Content.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Flora.Content.Infrastructure;

/// <summary>Фоновый воркер: читает очередь, транскодирует ffmpeg-ом, обновляет post_videos (Ready/Failed).</summary>
public sealed class PostVideoTranscodeWorker(
    PostVideoTranscodeQueue queue,
    IVideoTranscoder transcoder,
    IServiceScopeFactory scopeFactory,
    ILogger<PostVideoTranscodeWorker> logger) : BackgroundService
{
    /// <summary>Строки Processing старше порога на старте — осиротевшие задания прошлого запуска.</summary>
    private static readonly TimeSpan StaleProcessingAge = TimeSpan.FromMinutes(5);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await FailStaleProcessingAsync(stoppingToken);

        await foreach (var job in queue.Reader.ReadAllAsync(stoppingToken))
        {
            try
            {
                await ProcessJobAsync(job, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Необработанная ошибка транскодирования видео {VideoUuid}.", job.VideoUuid);
            }
            finally
            {
                TryDelete(job.TempInputPath);
            }
        }
    }

    private async Task ProcessJobAsync(PostVideoTranscodeJob job, CancellationToken ct)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ContentDbContext>();

        var video = await db.PostVideos.FirstOrDefaultAsync(v => v.Uuid == job.VideoUuid, ct);
        if (video == null)
            return;

        try
        {
            var result = await transcoder.TranscodeAsync(job.TempInputPath, ct);
            video.Data = result.VideoData;
            video.ContentType = result.VideoContentType;
            video.CompatibilityData = result.CompatibilityVideoData;
            video.CompatibilityContentType = result.CompatibilityVideoContentType;
            video.PosterData = result.PosterData;
            video.PosterContentType = result.PosterContentType;
            video.Width = result.Width;
            video.Height = result.Height;
            video.DurationMs = result.DurationMs;
            video.Status = PostVideoStatus.Ready;
            await db.SaveChangesAsync(ct);
            logger.LogInformation(
                "Видео {VideoUuid} готово: {Width}x{Height}, {DurationMs} мс, {Size} КБ.",
                video.Uuid, result.Width, result.Height, result.DurationMs, result.VideoData.Length / 1024);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Транскодирование видео {VideoUuid} не удалось.", job.VideoUuid);
            video.Status = PostVideoStatus.Failed;
            await db.SaveChangesAsync(CancellationToken.None);
        }
    }

    private async Task FailStaleProcessingAsync(CancellationToken ct)
    {
        try
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<ContentDbContext>();
            var threshold = DateTime.UtcNow - StaleProcessingAge;
            var failed = await db.PostVideos
                .Where(v => v.Status == PostVideoStatus.Processing && v.CreatedAt < threshold)
                .ExecuteUpdateAsync(s => s.SetProperty(v => v.Status, PostVideoStatus.Failed), ct);
            if (failed > 0)
                logger.LogWarning("Помечено Failed {Count} осиротевших видео (Processing с прошлого запуска).", failed);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Таблица может отсутствовать до применения миграций — не валим хост.
            logger.LogWarning(ex, "Не удалось проверить осиротевшие видео (миграции применены?).");
        }
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
