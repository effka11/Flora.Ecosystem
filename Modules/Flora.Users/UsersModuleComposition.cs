using Flora.Shared.Persistence;
using Flora.Users.Application.People;
using Flora.Users.Contracts;
using Flora.Users.Infrastructure;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Flora.Users;

public static class UsersModuleComposition
{
    public static IServiceCollection AddUsersModule(this IServiceCollection services, IConfiguration configuration)
    {
        var connectionString = configuration.GetConnectionString("FloraDatabase")
            ?? throw new InvalidOperationException("Connection string 'FloraDatabase' is not configured.");

        services.AddDbContext<UsersDbContext>((sp, o) =>
        {
            o.UseNpgsql(connectionString, n =>
            {
                n.MigrationsAssembly(typeof(UsersDbContext).Assembly.FullName);
                n.MigrationsHistoryTable("__EFMigrationsHistory_Users", "flora_core");
            });
            o.AddInterceptors(sp.GetRequiredService<TimestampAuditInterceptor>());
        });

        services.AddMemoryCache();
        services.Configure<UserRecommendationOptions>(configuration.GetSection(UserRecommendationOptions.SectionName));

        services.AddScoped<IUserProfileProvisioner, UserProfileProvisioner>();
        services.AddScoped<IFollowGraphReader, FollowGraphReader>();
        services.AddScoped<IUserProfileReadQueries, UserProfileReadQueries>();
        services.AddScoped<IUserRecommendationQueries, UserRecommendationQueries>();
        services.AddScoped<IUserRecommendationService, UserRecommendationService>();
        services.AddScoped<IUserPrivacySettingsService, UserPrivacySettingsService>();
        services.AddScoped<IProfileAccessPolicy, ProfileAccessPolicy>();
        services.AddScoped<IUserBlocklistService, UserBlocklistService>();
        services.AddScoped<IUserPresenceService, UserPresenceService>();

        return services;
    }

    public static IEndpointRouteBuilder MapUsersModuleEndpoints(this IEndpointRouteBuilder endpoints) => endpoints;
}
