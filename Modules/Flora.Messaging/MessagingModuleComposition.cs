using System.Security.Claims;
using System.Threading.RateLimiting;
using Flora.Messaging.Application;
using Flora.Messaging.Infrastructure;
using Flora.Shared.Persistence;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Flora.Messaging;

public static class MessagingModuleComposition
{
    /// <summary>Policy names for rate limiting (docs/fscp/e2e-security.md §Rate limits).</summary>
    public const string RateLimitPolicyE2ERecovery = "e2e-recovery-read";
    public const string RateLimitPolicyE2EKeyBackupWrite = "e2e-key-backup-write";
    public const string RateLimitPolicyE2EChallenge = "e2e-challenge";

    public static IServiceCollection AddMessagingModule(this IServiceCollection services, IConfiguration configuration)
    {
        var connectionString = configuration.GetConnectionString("FloraDatabase")
            ?? throw new InvalidOperationException("Connection string 'FloraDatabase' is not configured.");

        services.AddDbContext<MessagingDbContext>((sp, o) =>
        {
            o.UseNpgsql(connectionString, n =>
            {
                n.MigrationsAssembly(typeof(MessagingDbContext).Assembly.FullName);
                n.MigrationsHistoryTable("__EFMigrationsHistory_Messaging", "flora_core");
            });
            o.AddInterceptors(sp.GetRequiredService<TimestampAuditInterceptor>());
        });

        // Phase 1 services
        services.AddScoped<IConversationRepository, ConversationRepository>();
        services.AddScoped<IConversationService, ConversationService>();

        // Phase 2 services
        services.AddScoped<IE2EKeyBackupService, E2EKeyBackupService>();

        // Phase 3 services
        services.AddScoped<IE2EEpochService, E2EEpochService>();
        services.AddHostedService<IdempotencyCleanupService>();

        // Rate limiting per docs/fscp/e2e-security.md §Rate limits (per-user, using JWT sub claim)
        services.AddRateLimiter(opts =>
        {
            // GET recovery-backup/{id}: 5 per day per user
            opts.AddPolicy(RateLimitPolicyE2ERecovery, ctx =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: ctx.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? ctx.Connection.RemoteIpAddress?.ToString() ?? "anon",
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = 5,
                        Window = TimeSpan.FromDays(1),
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        QueueLimit = 0,
                    }));

            // PUT key-backup: 5 per day per user
            opts.AddPolicy(RateLimitPolicyE2EKeyBackupWrite, ctx =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: ctx.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? ctx.Connection.RemoteIpAddress?.ToString() ?? "anon",
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = 5,
                        Window = TimeSpan.FromDays(1),
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        QueueLimit = 0,
                    }));

            // POST unlock-complete/challenge: 20 per day per user
            opts.AddPolicy(RateLimitPolicyE2EChallenge, ctx =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: ctx.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? ctx.Connection.RemoteIpAddress?.ToString() ?? "anon",
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = 20,
                        Window = TimeSpan.FromDays(1),
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        QueueLimit = 0,
                    }));

            opts.RejectionStatusCode = 429;
        });

        return services;
    }

    public static IEndpointRouteBuilder MapMessagingModuleEndpoints(this IEndpointRouteBuilder endpoints) => endpoints;
}
