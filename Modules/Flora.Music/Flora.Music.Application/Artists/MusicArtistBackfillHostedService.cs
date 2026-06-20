using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Flora.Music.Application.Artists;

public sealed class MusicArtistBackfillHostedService(
    IServiceScopeFactory scopeFactory,
    ILogger<MusicArtistBackfillHostedService> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var backfill = scope.ServiceProvider.GetRequiredService<MusicArtistBackfillService>();
            await backfill.RunAsync(cancellationToken);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Music artist backfill skipped or failed.");
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
