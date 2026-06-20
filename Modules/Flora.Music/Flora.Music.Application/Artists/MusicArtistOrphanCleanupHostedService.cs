using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Flora.Music.Application.Artists;

public sealed class MusicArtistOrphanCleanupHostedService(
    IServiceScopeFactory scopeFactory,
    ILogger<MusicArtistOrphanCleanupHostedService> logger) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(5);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var scope = scopeFactory.CreateAsyncScope();
                var cleanup = scope.ServiceProvider.GetRequiredService<MusicArtistOrphanCleanupService>();
                await cleanup.RunAsync(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Music artist orphan cleanup skipped or failed.");
            }

            await Task.Delay(Interval, stoppingToken);
        }
    }
}
