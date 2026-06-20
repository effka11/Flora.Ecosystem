using Flora.Auth.Infrastructure;
using Flora.Content.Infrastructure;
using Flora.Messaging.Infrastructure;
using Flora.Music.Infrastructure;
using Flora.Notifications.Infrastructure;
using Flora.Users.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.Extensions.Configuration;

namespace Flora.Migrations;

internal static class DesignTimeConfiguration
{
    public static string GetConnectionString()
    {
        var basePath = Directory.GetCurrentDirectory();
        var config = new ConfigurationBuilder()
            .SetBasePath(basePath)
            .AddJsonFile("appsettings.json", optional: true)
            .AddEnvironmentVariables()
            .Build();
        return config.GetConnectionString("FloraDatabase")
            ?? throw new InvalidOperationException(
                "Connection string 'FloraDatabase' is missing. Set it in appsettings.json or ConnectionStrings__FloraDatabase.");
    }
}

public sealed class AuthDbContextFactory : IDesignTimeDbContextFactory<AuthDbContext>
{
    public AuthDbContext CreateDbContext(string[] args)
    {
        var cs = DesignTimeConfiguration.GetConnectionString();
        var o = new DbContextOptionsBuilder<AuthDbContext>();
        o.UseNpgsql(cs, n =>
        {
            n.MigrationsAssembly(typeof(AuthDbContext).Assembly.FullName);
            n.MigrationsHistoryTable("__EFMigrationsHistory_Auth", "flora_core");
        });
        return new AuthDbContext(o.Options);
    }
}

public sealed class UsersDbContextFactory : IDesignTimeDbContextFactory<UsersDbContext>
{
    public UsersDbContext CreateDbContext(string[] args)
    {
        var cs = DesignTimeConfiguration.GetConnectionString();
        var o = new DbContextOptionsBuilder<UsersDbContext>();
        o.UseNpgsql(cs, n =>
        {
            n.MigrationsAssembly(typeof(UsersDbContext).Assembly.FullName);
            n.MigrationsHistoryTable("__EFMigrationsHistory_Users", "flora_core");
        });
        return new UsersDbContext(o.Options);
    }
}

public sealed class ContentDbContextFactory : IDesignTimeDbContextFactory<ContentDbContext>
{
    public ContentDbContext CreateDbContext(string[] args)
    {
        var cs = DesignTimeConfiguration.GetConnectionString();
        var o = new DbContextOptionsBuilder<ContentDbContext>();
        o.UseNpgsql(cs, n =>
        {
            n.MigrationsAssembly(typeof(ContentDbContext).Assembly.FullName);
            n.MigrationsHistoryTable("__EFMigrationsHistory_Content", "flora_core");
        });
        return new ContentDbContext(o.Options);
    }
}

public sealed class MessagingDbContextFactory : IDesignTimeDbContextFactory<MessagingDbContext>
{
    public MessagingDbContext CreateDbContext(string[] args)
    {
        var cs = DesignTimeConfiguration.GetConnectionString();
        var o = new DbContextOptionsBuilder<MessagingDbContext>();
        o.UseNpgsql(cs, n =>
        {
            n.MigrationsAssembly(typeof(MessagingDbContext).Assembly.FullName);
            n.MigrationsHistoryTable("__EFMigrationsHistory_Messaging", "flora_core");
        });
        return new MessagingDbContext(o.Options);
    }
}

public sealed class NotificationsDbContextFactory : IDesignTimeDbContextFactory<NotificationsDbContext>
{
    public NotificationsDbContext CreateDbContext(string[] args)
    {
        var cs = DesignTimeConfiguration.GetConnectionString();
        var o = new DbContextOptionsBuilder<NotificationsDbContext>();
        o.UseNpgsql(cs, n =>
        {
            n.MigrationsAssembly(typeof(NotificationsDbContext).Assembly.FullName);
            n.MigrationsHistoryTable("__EFMigrationsHistory_Notifications", "flora_core");
        });
        return new NotificationsDbContext(o.Options);
    }
}

public sealed class MusicDbContextFactory : IDesignTimeDbContextFactory<MusicDbContext>
{
    public MusicDbContext CreateDbContext(string[] args)
    {
        var cs = DesignTimeConfiguration.GetConnectionString();
        var o = new DbContextOptionsBuilder<MusicDbContext>();
        o.UseNpgsql(cs, n =>
        {
            n.MigrationsAssembly(typeof(MusicDbContext).Assembly.FullName);
            n.MigrationsHistoryTable("__EFMigrationsHistory_Music", "flora_core");
        });
        return new MusicDbContext(o.Options);
    }
}
