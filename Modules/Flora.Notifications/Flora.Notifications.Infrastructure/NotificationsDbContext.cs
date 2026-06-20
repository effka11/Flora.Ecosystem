using Flora.Notifications.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Notifications.Infrastructure;

public class NotificationsDbContext : DbContext
{
    public NotificationsDbContext(DbContextOptions<NotificationsDbContext> options) : base(options) { }

    public DbSet<UserNotification> UserNotifications => Set<UserNotification>();
    public DbSet<UserPushToken> UserPushTokens => Set<UserPushToken>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);
        modelBuilder.HasDefaultSchema("flora_core");
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(NotificationsDbContext).Assembly);
    }
}
