using Flora.Content.Application.Communities;
using Flora.Content.Application.Feed;
using Flora.Content.Application.Videos;
using Flora.Content.Contracts;
using Flora.Content.Infrastructure;
using Flora.Shared.Persistence;
using Flora.Users.Contracts;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Flora.Content;

public static class ContentModuleComposition
{
    public static IServiceCollection AddContentModule(this IServiceCollection services, IConfiguration configuration)
    {
        var connectionString = configuration.GetConnectionString("FloraDatabase")
            ?? throw new InvalidOperationException("Connection string 'FloraDatabase' is not configured.");

        services.AddDbContext<ContentDbContext>((sp, o) =>
        {
            o.UseNpgsql(connectionString, n =>
            {
                n.MigrationsAssembly(typeof(ContentDbContext).Assembly.FullName);
                n.MigrationsHistoryTable("__EFMigrationsHistory_Content", "flora_core");
            });
            o.AddInterceptors(sp.GetRequiredService<TimestampAuditInterceptor>());
        });

        // Конфигурация FIRA-F (§docs/fira/FIRA-F.md)
        services.Configure<FiraFeedConfig>(
            configuration.GetSection(FiraFeedConfig.SectionName));

        // Конфигурация хронологической ленты «Подписки»
        services.Configure<FeedRecommendationOptions>(
            configuration.GetSection(FeedRecommendationOptions.SectionName));

        services.Configure<CommunityRecommendationOptions>(
            configuration.GetSection(CommunityRecommendationOptions.SectionName));

        // Транскодирование видео постов: ffmpeg (SVT-AV1) + in-memory очередь + фоновый воркер.
        services.Configure<MediaTranscodingOptions>(
            configuration.GetSection(MediaTranscodingOptions.SectionName));
        services.AddSingleton<IVideoTranscoder, FfmpegVideoTranscoder>();
        services.AddSingleton<PostVideoTranscodeQueue>();
        services.AddSingleton<IPostVideoTranscodeQueue>(sp => sp.GetRequiredService<PostVideoTranscodeQueue>());
        services.AddHostedService<PostVideoTranscodeWorker>();

        services.AddMemoryCache();
        services.AddScoped<IContentFeedQueries, ContentFeedQueries>();
        services.AddScoped<ICommunityRecommendationQueries, CommunityRecommendationQueries>();
        services.AddScoped<IFeedRecommendationService, FeedRecommendationService>();
        services.AddScoped<ICommunityRecommendationService, CommunityRecommendationService>();
        services.AddScoped<IPublicCommunityFollowingStats, PublicCommunityFollowingStats>();

        return services;
    }

    public static IEndpointRouteBuilder MapContentModuleEndpoints(this IEndpointRouteBuilder endpoints) => endpoints;
}
