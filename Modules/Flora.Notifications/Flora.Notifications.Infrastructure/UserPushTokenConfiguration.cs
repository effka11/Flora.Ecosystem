using Flora.Notifications.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Flora.Notifications.Infrastructure;

public sealed class UserPushTokenConfiguration : IEntityTypeConfiguration<UserPushToken>
{
    public void Configure(EntityTypeBuilder<UserPushToken> builder)
    {
        builder.ToTable("user_push_tokens");
        builder.HasKey(e => e.PushTokenUuid).HasName("pk_user_push_tokens");
        builder.Property(e => e.Token).HasMaxLength(512).IsRequired();
        builder.Property(e => e.Platform).HasMaxLength(16).IsRequired();
        builder.HasIndex(e => e.Token).IsUnique().HasDatabaseName("ix_user_push_tokens_token");
        builder.HasIndex(e => new { e.UserUuid, e.UpdatedAt }).HasDatabaseName("ix_user_push_tokens_user_updated");
    }
}
