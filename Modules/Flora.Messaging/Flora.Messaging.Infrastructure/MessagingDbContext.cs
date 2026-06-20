using Flora.Messaging.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Messaging.Infrastructure;

public class MessagingDbContext : DbContext
{
    public MessagingDbContext(DbContextOptions<MessagingDbContext> options) : base(options) { }

    public DbSet<UserMessage> UserMessages => Set<UserMessage>();
    public DbSet<UserE2EKey> UserE2EKeys => Set<UserE2EKey>();
    public DbSet<UserMessageVoiceAsset> UserMessageVoiceAssets => Set<UserMessageVoiceAsset>();
    public DbSet<UserMessageImageAsset> UserMessageImageAssets => Set<UserMessageImageAsset>();
    public DbSet<UserMessageVideoAsset> UserMessageVideoAssets => Set<UserMessageVideoAsset>();

    // Phase 2 — E2E key backup infrastructure
    public DbSet<UserE2EAccountState> UserE2EAccountStates => Set<UserE2EAccountState>();
    public DbSet<UserE2EKeyBackup> UserE2EKeyBackups => Set<UserE2EKeyBackup>();
    public DbSet<UserE2ERecoveryBackup> UserE2ERecoveryBackups => Set<UserE2ERecoveryBackup>();
    public DbSet<KeyEpochPublicIdentity> KeyEpochPublicIdentities => Set<KeyEpochPublicIdentity>();

    // Phase 3 — device management, unlock challenges, idempotency
    public DbSet<UserDeviceKey> UserDeviceKeys => Set<UserDeviceKey>();
    public DbSet<UserE2EUnlockChallenge> UserE2EUnlockChallenges => Set<UserE2EUnlockChallenge>();
    public DbSet<UserE2EIdempotencyRecord> UserE2EIdempotencyRecords => Set<UserE2EIdempotencyRecord>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);
        modelBuilder.HasDefaultSchema("flora_core");
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(MessagingDbContext).Assembly);
    }
}
