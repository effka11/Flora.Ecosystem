using Flora.Content.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Flora.Content.Infrastructure;

public class PostDraftConfiguration : IEntityTypeConfiguration<PostDraft>
{
    public void Configure(EntityTypeBuilder<PostDraft> builder)
    {
        builder.ToTable("post_drafts", "flora_core");
        builder.HasKey(e => e.DraftUuid).HasName("pk_post_drafts");
        builder.Property(e => e.DraftUuid).HasColumnName("draft_uuid");
        builder.Property(e => e.AuthorUserUuid).HasColumnName("author_user_uuid");
        builder.Property(e => e.CommunityId).HasColumnName("community_id");
        builder.Property(e => e.Label).HasColumnName("label").IsRequired().HasMaxLength(50);
        builder.Property(e => e.Content).HasColumnName("content").IsRequired().HasMaxLength(2000);
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(e => e.UpdatedAt).HasColumnName("updated_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.HasIndex(e => e.AuthorUserUuid).HasDatabaseName("ix_post_drafts_author_user_uuid");
        builder.HasIndex(e => new { e.AuthorUserUuid, e.CommunityId }).HasDatabaseName("ix_post_drafts_author_community");
    }
}

public class UserPostConfiguration : IEntityTypeConfiguration<UserPost>
{
    public void Configure(EntityTypeBuilder<UserPost> builder)
    {
        builder.ToTable("user_posts", "flora_core");
        builder.HasKey(e => e.PostUuid).HasName("pk_user_posts");
        builder.Property(e => e.PostUuid).HasColumnName("post_uuid");
        builder.Property(e => e.AuthorUserUuid).HasColumnName("author_user_uuid");
        builder.Property(e => e.CommunityId).HasColumnName("community_id");
        builder.Property(e => e.Content).HasColumnName("content").IsRequired().HasMaxLength(2000);
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(e => e.IsDeleted).HasColumnName("is_deleted").HasDefaultValue(false);
        builder.Property(e => e.DeletedAt).HasColumnName("deleted_at");
        builder.HasIndex(e => e.AuthorUserUuid).HasDatabaseName("ix_user_posts_author_user_uuid");
        builder.HasIndex(e => e.CommunityId).HasDatabaseName("ix_user_posts_community_id");
    }
}

public class PostCommentConfiguration : IEntityTypeConfiguration<PostComment>
{
    public void Configure(EntityTypeBuilder<PostComment> builder)
    {
        builder.ToTable("post_comments", "flora_core");
        builder.HasKey(e => e.CommentUuid).HasName("pk_post_comments");
        builder.Property(e => e.CommentUuid).HasColumnName("comment_uuid");
        builder.Property(e => e.PostUuid).HasColumnName("post_uuid");
        builder.Property(e => e.ParentCommentUuid).HasColumnName("parent_comment_uuid");
        builder.Property(e => e.AuthorUserUuid).HasColumnName("author_user_uuid");
        builder.Property(e => e.Content).HasColumnName("content").IsRequired().HasMaxLength(1000);
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(e => e.IsDeleted).HasColumnName("is_deleted").HasDefaultValue(false);
        builder.Property(e => e.DeletedAt).HasColumnName("deleted_at");
        builder.HasIndex(e => e.PostUuid).HasDatabaseName("ix_post_comments_post_uuid");
        builder.HasIndex(e => new { e.PostUuid, e.ParentCommentUuid, e.CreatedAt })
               .HasDatabaseName("ix_post_comments_post_parent_created");
        builder.HasIndex(e => e.ParentCommentUuid).HasDatabaseName("ix_post_comments_parent_comment_uuid");
        builder.HasIndex(e => e.AuthorUserUuid).HasDatabaseName("ix_post_comments_author_user_uuid");
    }
}

public class PostLikeConfiguration : IEntityTypeConfiguration<PostLike>
{
    public void Configure(EntityTypeBuilder<PostLike> builder)
    {
        builder.ToTable("post_likes", "flora_core");
        builder.HasKey(e => new { e.PostUuid, e.UserUuid }).HasName("pk_post_likes");
        builder.Property(e => e.PostUuid).HasColumnName("post_uuid");
        builder.Property(e => e.UserUuid).HasColumnName("user_uuid");
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.HasIndex(e => e.PostUuid).HasDatabaseName("ix_post_likes_post_uuid");
    }
}

public class PostRepostConfiguration : IEntityTypeConfiguration<PostRepost>
{
    public void Configure(EntityTypeBuilder<PostRepost> builder)
    {
        builder.ToTable("post_reposts", "flora_core");
        builder.HasKey(e => new { e.PostUuid, e.UserUuid }).HasName("pk_post_reposts");
        builder.Property(e => e.PostUuid).HasColumnName("post_uuid");
        builder.Property(e => e.UserUuid).HasColumnName("user_uuid");
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.HasIndex(e => e.PostUuid).HasDatabaseName("ix_post_reposts_post_uuid");
    }
}

public class PostViewConfiguration : IEntityTypeConfiguration<PostView>
{
    public void Configure(EntityTypeBuilder<PostView> builder)
    {
        builder.ToTable("post_views", "flora_core");
        builder.HasKey(e => new { e.PostUuid, e.UserUuid }).HasName("pk_post_views");
        builder.Property(e => e.PostUuid).HasColumnName("post_uuid");
        builder.Property(e => e.UserUuid).HasColumnName("user_uuid");
        builder.Property(e => e.ViewedAt).HasColumnName("viewed_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.HasIndex(e => e.PostUuid).HasDatabaseName("ix_post_views_post_uuid");
    }
}

public class PostImageConfiguration : IEntityTypeConfiguration<PostImage>
{
    public void Configure(EntityTypeBuilder<PostImage> builder)
    {
        builder.ToTable("post_images", "flora_core");
        builder.HasKey(e => e.Uuid).HasName("pk_post_images");
        builder.Property(e => e.Uuid).HasColumnName("uuid");
        builder.Property(e => e.PostUuid).HasColumnName("post_uuid");
        builder.Property(e => e.ContentType).HasColumnName("content_type").HasMaxLength(100).IsRequired();
        builder.Property(e => e.Data).HasColumnName("data").IsRequired();
        builder.Property(e => e.SortOrder).HasColumnName("sort_order");
        builder.HasIndex(e => e.PostUuid).HasDatabaseName("ix_post_images_post_uuid");
    }
}

public class PostVideoConfiguration : IEntityTypeConfiguration<PostVideo>
{
    public void Configure(EntityTypeBuilder<PostVideo> builder)
    {
        builder.ToTable("post_videos", "flora_core");
        builder.HasKey(e => e.Uuid).HasName("pk_post_videos");
        builder.Property(e => e.Uuid).HasColumnName("uuid");
        builder.Property(e => e.PostUuid).HasColumnName("post_uuid");
        builder.Property(e => e.Status).HasColumnName("status");
        builder.Property(e => e.ContentType).HasColumnName("content_type").HasMaxLength(100).IsRequired();
        builder.Property(e => e.Data).HasColumnName("data").IsRequired();
        builder.Property(e => e.CompatibilityData).HasColumnName("compatibility_data");
        builder.Property(e => e.CompatibilityContentType).HasColumnName("compatibility_content_type").HasMaxLength(100);
        builder.Property(e => e.PosterData).HasColumnName("poster_data").IsRequired();
        builder.Property(e => e.PosterContentType).HasColumnName("poster_content_type").HasMaxLength(100).IsRequired();
        builder.Property(e => e.Width).HasColumnName("width");
        builder.Property(e => e.Height).HasColumnName("height");
        builder.Property(e => e.DurationMs).HasColumnName("duration_ms");
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.HasIndex(e => e.PostUuid).HasDatabaseName("ix_post_videos_post_uuid");
    }
}

public class CommunityConfiguration : IEntityTypeConfiguration<Community>
{
    public void Configure(EntityTypeBuilder<Community> builder)
    {
        builder.ToTable("communities", "flora_core");
        builder.HasKey(e => e.CommunityId).HasName("pk_communities");
        builder.Property(e => e.CommunityId).HasColumnName("community_id");
        builder.Property(e => e.Name).HasColumnName("name").IsRequired().HasMaxLength(100);
        builder.Property(e => e.Slug).HasColumnName("slug").IsRequired().HasMaxLength(100);
        builder.Property(e => e.IsPrivate).HasColumnName("is_private").HasDefaultValue(true);
        builder.Property(e => e.AvatarUuid).HasColumnName("avatar_uuid");
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.HasIndex(e => e.Slug).IsUnique().HasDatabaseName("ix_communities_slug");
    }
}

public class CommunityAvatarConfiguration : IEntityTypeConfiguration<CommunityAvatar>
{
    public void Configure(EntityTypeBuilder<CommunityAvatar> builder)
    {
        builder.ToTable("community_avatars", "flora_core");
        builder.HasKey(e => e.Uuid).HasName("pk_community_avatars");
        builder.Property(e => e.Uuid).HasColumnName("uuid");
        builder.Property(e => e.CommunityId).HasColumnName("community_id");
        builder.Property(e => e.ContentType).HasColumnName("content_type").HasMaxLength(100).IsRequired();
        builder.Property(e => e.Data).HasColumnName("data").IsRequired();
        builder.Property(e => e.CreatedAt).HasColumnName("created_at");
        builder.HasIndex(e => e.CommunityId).HasDatabaseName("ix_community_avatars_community_id");
    }
}

public class UserCommunityConfiguration : IEntityTypeConfiguration<UserCommunity>
{
    public void Configure(EntityTypeBuilder<UserCommunity> builder)
    {
        builder.ToTable("user_communities", "flora_core");
        builder.HasKey(e => new { e.UserUuid, e.CommunityId }).HasName("pk_user_communities");
        builder.Property(e => e.UserUuid).HasColumnName("user_uuid");
        builder.Property(e => e.CommunityId).HasColumnName("community_id");
        builder.Property(e => e.Role).HasColumnName("role").IsRequired().HasMaxLength(32).HasDefaultValue("Member");
        builder.Property(e => e.JoinedAt).HasColumnName("joined_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.HasIndex(e => e.CommunityId).HasDatabaseName("ix_user_communities_community_id");
    }
}
