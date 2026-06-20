using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Npgsql;

namespace Flora.Messaging.Infrastructure;

/// <summary>
/// Background service that periodically purges expired UserE2EIdempotencyRecord and
/// UserE2EUnlockChallenge rows.
/// </summary>
public sealed class IdempotencyCleanupService(
    IServiceScopeFactory scopeFactory,
    ILogger<IdempotencyCleanupService> logger) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromHours(6);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var scope = scopeFactory.CreateAsyncScope();
                var db = scope.ServiceProvider.GetRequiredService<MessagingDbContext>();

                var now = DateTime.UtcNow;
                var idempotencyDeleted = await db.UserE2EIdempotencyRecords
                    .Where(r => r.ExpiresAt < now)
                    .ExecuteDeleteAsync(stoppingToken);
                var challengeDeleted = await db.UserE2EUnlockChallenges
                    .Where(c => c.ExpiresAt < now)
                    .ExecuteDeleteAsync(stoppingToken);

                if (idempotencyDeleted > 0 || challengeDeleted > 0)
                    logger.LogInformation(
                        "Idempotency cleanup: removed {I} idempotency records and {C} stale challenges.",
                        idempotencyDeleted, challengeDeleted);
            }
            catch (PostgresException ex) when (ex.SqlState == PostgresErrorCodes.UndefinedTable)
            {
                // Migrations not applied yet — skip until tables exist.
                logger.LogWarning(
                    "Idempotency cleanup skipped: messaging E2E tables are missing. " +
                    "Run `dotnet ef database update` for MessagingDbContext.");
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "Error during idempotency cleanup.");
            }

            await Task.Delay(Interval, stoppingToken);
        }
    }
}
