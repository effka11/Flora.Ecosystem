using Flora.Verification.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Flora.Verification.Infrastructure;

public class VerificationChallengeConfiguration : IEntityTypeConfiguration<VerificationChallenge>
{
    public void Configure(EntityTypeBuilder<VerificationChallenge> builder)
    {
        builder.ToTable("verification_challenges", "flora_core");
        builder.HasKey(e => e.Token).HasName("pk_verification_challenges");
        builder.Property(e => e.Token).HasColumnName("token");
        builder.Property(e => e.Kind).HasColumnName("kind").IsRequired();
        builder.Property(e => e.Target).HasColumnName("target").IsRequired().HasMaxLength(255);
        builder.Property(e => e.SubjectUserUuid).HasColumnName("subject_user_uuid");
        builder.Property(e => e.CodeHash).HasColumnName("code_hash").IsRequired().HasMaxLength(128);
        builder.Property(e => e.ExpiresAt).HasColumnName("expires_at").IsRequired();
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(e => e.UpdatedAt).HasColumnName("updated_at").HasDefaultValueSql("CURRENT_TIMESTAMP").ValueGeneratedOnAddOrUpdate();
        builder.Property(e => e.Attempts).HasColumnName("attempts").HasDefaultValue(0);
        builder.HasIndex(e => e.Target).HasDatabaseName("ix_verification_challenges_target");
        builder.HasIndex(e => e.ExpiresAt).HasDatabaseName("ix_verification_challenges_expires_at");
        builder.HasIndex(e => e.SubjectUserUuid).HasDatabaseName("ix_verification_challenges_subject_user_uuid");
    }
}
