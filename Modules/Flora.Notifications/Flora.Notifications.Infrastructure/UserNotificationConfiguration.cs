using Flora.Notifications.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Flora.Notifications.Infrastructure;

public class UserNotificationConfiguration : IEntityTypeConfiguration<UserNotification>
{
    public void Configure(EntityTypeBuilder<UserNotification> builder)
    {
        builder.ToTable("user_notifications");
        builder.HasKey(e => e.NotificationUuid).HasName("pk_user_notifications");
        builder.Property(e => e.NotificationUuid).HasColumnName("notification_uuid");
        builder.Property(e => e.RecipientUserUuid).HasColumnName("recipient_user_uuid").IsRequired();
        builder.Property(e => e.ActorUserUuid).HasColumnName("actor_user_uuid");
        builder.Property(e => e.Type).HasColumnName("type").HasMaxLength(32).IsRequired();
        builder.Property(e => e.Category).HasColumnName("category").HasMaxLength(16).IsRequired();
        builder.Property(e => e.Text).HasColumnName("text").HasMaxLength(500).IsRequired();
        builder.Property(e => e.TargetPlatform).HasColumnName("target_platform").HasMaxLength(16);
        builder.Property(e => e.PostUuid).HasColumnName("post_uuid");
        builder.Property(e => e.CommentUuid).HasColumnName("comment_uuid");
        builder.Property(e => e.IsRead).HasColumnName("is_read").IsRequired();
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").IsRequired().HasDefaultValueSql("CURRENT_TIMESTAMP");

        builder.HasIndex(e => new { e.RecipientUserUuid, e.CreatedAt })
            .HasDatabaseName("ix_user_notifications_recipient_created");
        builder.HasIndex(e => new { e.RecipientUserUuid, e.IsRead })
            .HasDatabaseName("ix_user_notifications_recipient_read");
    }
}
