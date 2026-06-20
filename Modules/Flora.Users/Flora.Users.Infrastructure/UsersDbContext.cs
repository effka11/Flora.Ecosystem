using Flora.Users.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Users.Infrastructure;

public class UsersDbContext : DbContext
{
    public UsersDbContext(DbContextOptions<UsersDbContext> options) : base(options) { }

    public DbSet<UserProfile> UserProfiles => Set<UserProfile>();
    public DbSet<UserAvatar> UserAvatars => Set<UserAvatar>();
    public DbSet<UserFollower> UserFollowers => Set<UserFollower>();
    public DbSet<UserPrivacySettings> UserPrivacySettings => Set<UserPrivacySettings>();
    public DbSet<UserBlock> UserBlocks => Set<UserBlock>();
    public DbSet<UserPresence> UserPresences => Set<UserPresence>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);
        modelBuilder.HasDefaultSchema("flora_core");
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(UsersDbContext).Assembly);
    }
}
