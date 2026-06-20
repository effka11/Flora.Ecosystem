using Flora.Users.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Flora.Users.Infrastructure;

public class UserProfileConfiguration : IEntityTypeConfiguration<UserProfile>
{
    public void Configure(EntityTypeBuilder<UserProfile> builder)
    {
        builder.ToTable("user_profiles", "flora_core");
        builder.HasKey(e => e.UserUuid).HasName("pk_user_profiles");
        builder.Property(e => e.UserUuid).HasColumnName("user_uuid");
        builder.Property(e => e.AvatarUuid).HasColumnName("avatar_uuid");
        builder.Property(e => e.DisplayName).HasColumnName("display_name").IsRequired().HasMaxLength(100).HasDefaultValue(string.Empty);
        builder.Property(e => e.Gender).HasColumnName("gender").HasConversion<int?>();
        builder.Property(e => e.BirthDate).HasColumnName("birth_date").HasColumnType("date");
        builder.Property(e => e.Status).HasColumnName("status").HasMaxLength(500);
        builder.Property(e => e.UpdatedAt).HasColumnName("updated_at").HasDefaultValueSql("CURRENT_TIMESTAMP").ValueGeneratedOnAddOrUpdate();
    }
}

public class UserAvatarConfiguration : IEntityTypeConfiguration<UserAvatar>
{
    public void Configure(EntityTypeBuilder<UserAvatar> builder)
    {
        builder.ToTable("user_avatars", "flora_core");
        builder.HasKey(e => e.Uuid).HasName("pk_user_avatars");
        builder.Property(e => e.Uuid).HasColumnName("uuid");
        builder.Property(e => e.UserUuid).HasColumnName("user_uuid");
        builder.Property(e => e.ContentType).HasColumnName("content_type").HasMaxLength(100).IsRequired();
        builder.Property(e => e.Data).HasColumnName("data").IsRequired();
        builder.Property(e => e.CreatedAt).HasColumnName("created_at");
    }
}

public class UserPrivacySettingsConfiguration : IEntityTypeConfiguration<UserPrivacySettings>
{
    public void Configure(EntityTypeBuilder<UserPrivacySettings> builder)
    {
        builder.ToTable("user_privacy_settings", "flora_core");
        builder.HasKey(e => e.UserUuid).HasName("pk_user_privacy_settings");
        builder.Property(e => e.UserUuid).HasColumnName("user_uuid");
        builder.Property(e => e.FriendsVisibility).HasColumnName("friends_visibility").HasConversion<int>().HasDefaultValue(ProfileVisibility.All);
        builder.Property(e => e.SubscriptionsVisibility).HasColumnName("subscriptions_visibility").HasConversion<int>().HasDefaultValue(ProfileVisibility.All);
        builder.Property(e => e.PostsVisibility).HasColumnName("posts_visibility").HasConversion<int>().HasDefaultValue(ProfileVisibility.All);
        builder.Property(e => e.LikesVisibility).HasColumnName("likes_visibility").HasConversion<int>().HasDefaultValue(ProfileVisibility.Friends);
        builder.Property(e => e.RepostsVisibility).HasColumnName("reposts_visibility").HasConversion<int>().HasDefaultValue(ProfileVisibility.All);
        builder.Property(e => e.MessagesFrom).HasColumnName("messages_from").HasConversion<int>().HasDefaultValue(UserMessagesFrom.All);
        builder.Property(e => e.CommentsFrom).HasColumnName("comments_from").HasConversion<int>().HasDefaultValue(ProfileVisibility.All);
        builder.Property(e => e.OnlineFriends).HasColumnName("online_friends").HasConversion<int>().HasDefaultValue(OnlineVisibilitySetting.Visible);
        builder.Property(e => e.OnlineStrangers).HasColumnName("online_strangers").HasConversion<int>().HasDefaultValue(OnlineVisibilitySetting.Hidden);
        builder.Property(e => e.UpdatedAt).HasColumnName("updated_at").HasDefaultValueSql("CURRENT_TIMESTAMP").ValueGeneratedOnAddOrUpdate();
    }
}

public class UserBlockConfiguration : IEntityTypeConfiguration<UserBlock>
{
    public void Configure(EntityTypeBuilder<UserBlock> builder)
    {
        builder.ToTable("user_blocks", "flora_core");
        builder.HasKey(e => new { e.OwnerUserUuid, e.BlockedUserUuid }).HasName("pk_user_blocks");
        builder.Property(e => e.OwnerUserUuid).HasColumnName("owner_user_uuid");
        builder.Property(e => e.BlockedUserUuid).HasColumnName("blocked_user_uuid");
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.HasIndex(e => e.BlockedUserUuid).HasDatabaseName("ix_user_blocks_blocked_user_uuid");
    }
}

public class UserPresenceConfiguration : IEntityTypeConfiguration<UserPresence>
{
    public void Configure(EntityTypeBuilder<UserPresence> builder)
    {
        builder.ToTable("user_presence", "flora_core");
        builder.HasKey(e => e.UserUuid).HasName("pk_user_presence");
        builder.Property(e => e.UserUuid).HasColumnName("user_uuid");
        builder.Property(e => e.LastSeenAtUtc).HasColumnName("last_seen_at_utc").HasDefaultValueSql("CURRENT_TIMESTAMP");
    }
}

public class UserFollowerConfiguration : IEntityTypeConfiguration<UserFollower>
{
    public void Configure(EntityTypeBuilder<UserFollower> builder)
    {
        builder.ToTable("user_followers", "flora_core");
        builder.HasKey(e => new { e.FollowerUserUuid, e.FollowingUserUuid }).HasName("pk_user_followers");
        builder.Property(e => e.FollowerUserUuid).HasColumnName("follower_user_uuid");
        builder.Property(e => e.FollowingUserUuid).HasColumnName("following_user_uuid");
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.HasIndex(e => e.FollowingUserUuid).HasDatabaseName("ix_user_followers_following_user_uuid");
    }
}
