using Flora.Music.Application.Artists;
using Flora.Music.Application.Genres;
using Flora.Music.Application.Playlists;
using Flora.Music.Application.Recommendations;
using Flora.Music.Application.Tracks;
using Flora.Music.Contracts;
using Flora.Music.Infrastructure;
using Flora.Shared.Persistence;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Flora.Music;

public static class MusicModuleComposition
{
    public static IServiceCollection AddMusicModule(this IServiceCollection services, IConfiguration configuration)
    {
        var connectionString = configuration.GetConnectionString("FloraDatabase")
            ?? throw new InvalidOperationException("Connection string 'FloraDatabase' is not configured.");

        services.AddDbContext<MusicDbContext>((sp, o) =>
        {
            o.UseNpgsql(connectionString, n =>
            {
                n.MigrationsAssembly(typeof(MusicDbContext).Assembly.FullName);
                n.MigrationsHistoryTable("__EFMigrationsHistory_Music", "flora_core");
            });
            o.AddInterceptors(sp.GetRequiredService<TimestampAuditInterceptor>());
        });

        services.Configure<MusicMediaOptions>(configuration.GetSection(MusicMediaOptions.SectionName));
        services.Configure<MusicRecommendationOptions>(configuration.GetSection(MusicRecommendationOptions.SectionName));
        services.AddMemoryCache();
        services.AddSingleton<IAudioTranscoder, FfmpegMusicAudioTranscoder>();
        services.AddScoped<IMusicTrackRepository, MusicTrackRepository>();
        services.AddScoped<MusicTrackDtoMapper>();
        services.AddScoped<IMusicTrackService, MusicTrackService>();
        services.AddScoped<IMusicPlaylistRepository, MusicPlaylistRepository>();
        services.AddScoped<IMusicPlaylistService, MusicPlaylistService>();
        services.AddScoped<IMusicRecommendationRepository, MusicRecommendationRepository>();
        services.AddScoped<IMusicRecommendationService, MusicRecommendationService>();
        services.AddScoped<IMusicGenreRepository, MusicGenreRepository>();
        services.AddScoped<IMusicGenreService, MusicGenreService>();
        services.AddScoped<IMusicArtistRepository, MusicArtistRepository>();
        services.AddScoped<IMusicArtistService, MusicArtistService>();
        services.AddScoped<MusicArtistTrackAttachService>();
        services.AddScoped<MusicArtistObsoleteFallback>();
        services.AddScoped<MusicArtistBackfillService>();
        services.AddHostedService<MusicArtistBackfillHostedService>();
        services.AddScoped<MusicArtistOrphanCleanupService>();
        services.AddHostedService<MusicArtistOrphanCleanupHostedService>();

        return services;
    }

    /// <summary>
    /// Registers this module's HTTP controllers (route prefix <c>api/music</c>) as an MVC application part,
    /// so any product host exposes them by chaining this onto <c>AddControllers()</c>.
    /// </summary>
    public static IMvcBuilder AddMusicModuleControllers(this IMvcBuilder builder) =>
        builder.AddApplicationPart(typeof(MusicModuleComposition).Assembly);

    public static IEndpointRouteBuilder MapMusicModuleEndpoints(this IEndpointRouteBuilder endpoints) => endpoints;
}
