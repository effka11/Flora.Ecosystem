using Flora.Verification.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Verification.Infrastructure;

public class VerificationDbContext : DbContext
{
    public VerificationDbContext(DbContextOptions<VerificationDbContext> options) : base(options) { }

    public DbSet<VerificationChallenge> VerificationChallenges => Set<VerificationChallenge>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);
        modelBuilder.HasDefaultSchema("flora_core");
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(VerificationDbContext).Assembly);
    }
}
