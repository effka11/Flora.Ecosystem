using Flora.Notifications.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Flora.Notifications.Infrastructure;

public class UserClientPlatformConfiguration : IEntityTypeConfiguration<UserClientPlatform>
{
    public void Configure(EntityTypeBuilder<UserClientPlatform> builder)
    {
        builder.ToTable("user_client_platforms");
        builder.HasKey(e => new { e.UserUuid, e.Platform }).HasName("pk_user_client_platforms");
        builder.Property(e => e.UserUuid).HasColumnName("user_uuid");
        builder.Property(e => e.Platform).HasColumnName("platform").HasMaxLength(16).IsRequired();
        builder.Property(e => e.UpdatedAt).HasColumnName("updated_at").IsRequired().HasDefaultValueSql("CURRENT_TIMESTAMP");

        builder.HasIndex(e => new { e.Platform, e.UserUuid })
            .HasDatabaseName("ix_user_client_platforms_platform_user");
    }
}
