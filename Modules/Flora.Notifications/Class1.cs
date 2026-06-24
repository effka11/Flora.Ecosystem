using Flora.Messaging.Contracts;
using Flora.Notifications.Application;
using Flora.Notifications.Infrastructure;
using Flora.Shared.Persistence;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Flora.Notifications;

public static class NotificationsModuleComposition
{
    public static IServiceCollection AddNotificationsModule(this IServiceCollection services, IConfiguration configuration)
    {
        var connectionString = configuration.GetConnectionString("FloraDatabase")
            ?? throw new InvalidOperationException("Connection string 'FloraDatabase' is not configured.");

        services.AddDbContext<NotificationsDbContext>((sp, o) =>
        {
            o.UseNpgsql(connectionString, n =>
            {
                n.MigrationsAssembly(typeof(NotificationsDbContext).Assembly.FullName);
                n.MigrationsHistoryTable("__EFMigrationsHistory_Notifications", "flora_core");
            });
            o.AddInterceptors(sp.GetRequiredService<TimestampAuditInterceptor>());
        });

        services.AddScoped<INotificationInboxService, NotificationInboxService>();
        services.AddScoped<IPushTokenService, PushTokenService>();
        services.AddScoped<IUserDisplayNameResolver, UserDisplayNameResolver>();
        services.AddSingleton<IUserRealtimeHub, UserRealtimeHub>();
        services.AddScoped<IUserRealtimePublisher, UserRealtimePublisher>();
        services.AddScoped<IMessagePushDispatcher, FcmPushSender>();
        services.AddScoped<IMessageSentNotifier, MessagePushNotifier>();
        return services;
    }

    /// <summary>
    /// Registers this module's HTTP controllers (notifications, push-token, signals) as an MVC application
    /// part, so any product host exposes them by chaining this onto <c>AddControllers()</c>.
    /// </summary>
    public static IMvcBuilder AddNotificationsModuleControllers(this IMvcBuilder builder) =>
        builder.AddApplicationPart(typeof(NotificationsModuleComposition).Assembly);

    public static IEndpointRouteBuilder MapNotificationsModuleEndpoints(this IEndpointRouteBuilder endpoints) => endpoints;
}
