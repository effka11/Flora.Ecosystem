using Flora.Auth;
using Flora.Content;
using Flora.Messaging;
using Flora.Music;
using Flora.Notifications;
using Flora.Notifications.Application;
using Flora.Shared.Persistence;
using Flora.Users;
using Flora.Verification;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Flora.Social;

public static class FloraSocialComposition
{
    public static IServiceCollection AddFloraSocialProduct(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddSingleton<TimestampAuditInterceptor>();

        services
            .AddUsersModule(configuration)
            .AddAuthModule(configuration)
            .AddVerificationModule()
            .AddNotificationsModule(configuration)
            .AddContentModule(configuration)
            .AddMessagingModule(configuration)
            .AddMusicModule(configuration);

        services.AddScoped<IUserDisplayNameResolver, SocialUserDisplayNameResolver>();

        services.AddFloraJwtBearer(configuration);

        // Cross-cutting abuse caps for the Social HTTP surface (auth/uploads/writes). The messaging
        // module registers its own per-user E2E policies into the same RateLimiterOptions.
        services.AddSocialRateLimitPolicies();

        services.AddControllers()
            .AddApplicationPart(typeof(ImportedSocialController).Assembly)
            .AddJsonOptions(options =>
            {
                options.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
                options.JsonSerializerOptions.DictionaryKeyPolicy = JsonNamingPolicy.CamelCase;
                options.JsonSerializerOptions.PropertyNameCaseInsensitive = true;
                options.JsonSerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
            });

        services.AddAuthorization();

        return services;
    }

    public static IEndpointRouteBuilder MapFloraSocialProduct(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapControllers();
        endpoints.MapAuthModuleGrpc();
        endpoints.MapUsersModuleEndpoints();
        endpoints.MapContentModuleEndpoints();
        endpoints.MapMessagingModuleEndpoints();
        endpoints.MapMusicModuleEndpoints();
        return endpoints;
    }
}
