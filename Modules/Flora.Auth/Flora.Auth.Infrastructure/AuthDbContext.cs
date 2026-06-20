using Flora.Auth.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Auth.Infrastructure;

public class AuthDbContext : DbContext
{
    public AuthDbContext(DbContextOptions<AuthDbContext> options) : base(options) { }

    public DbSet<UserAccount> UserAccounts => Set<UserAccount>();
    public DbSet<UserSecurityLogs> UserSecurityLogs => Set<UserSecurityLogs>();
    public DbSet<UserSession> UserSessions => Set<UserSession>();
    public DbSet<PendingRegistration> PendingRegistrations => Set<PendingRegistration>();
    public DbSet<PendingEmailChange> PendingEmailChanges => Set<PendingEmailChange>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);
        modelBuilder.HasDefaultSchema("flora_core");
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(AuthDbContext).Assembly);
    }
}
