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
        services.AddSingleton<IUserRealtimeHub, UserRealtimeHub>();
        services.AddScoped<IUserRealtimePublisher, UserRealtimePublisher>();
        services.AddScoped<IMessagePushDispatcher, FcmPushSender>();
        services.AddScoped<IMessageSentNotifier, MessagePushNotifier>();
        return services;
    }

    public static IEndpointRouteBuilder MapNotificationsModuleEndpoints(this IEndpointRouteBuilder endpoints) => endpoints;
}
