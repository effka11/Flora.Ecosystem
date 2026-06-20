using Flora.Content.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Content.Infrastructure;

public class ContentDbContext : DbContext
{
    public ContentDbContext(DbContextOptions<ContentDbContext> options) : base(options) { }

    public DbSet<UserPost> UserPosts => Set<UserPost>();
    public DbSet<PostDraft> PostDrafts => Set<PostDraft>();
    public DbSet<PostComment> PostComments => Set<PostComment>();
    public DbSet<PostLike> PostLikes => Set<PostLike>();
    public DbSet<PostRepost> PostReposts => Set<PostRepost>();
    public DbSet<PostView> PostViews => Set<PostView>();
    public DbSet<PostImage> PostImages => Set<PostImage>();
    public DbSet<PostVideo> PostVideos => Set<PostVideo>();
    public DbSet<Community> Communities => Set<Community>();
    public DbSet<CommunityAvatar> CommunityAvatars => Set<CommunityAvatar>();
    public DbSet<UserCommunity> UserCommunities => Set<UserCommunity>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);
        modelBuilder.HasDefaultSchema("flora_core");
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(ContentDbContext).Assembly);

        modelBuilder.Entity<PostComment>()
            .HasOne<UserPost>().WithMany().HasForeignKey(c => c.PostUuid)
            .HasConstraintName("fk_post_comments_post").OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<PostComment>()
            .HasOne<PostComment>().WithMany().HasForeignKey(c => c.ParentCommentUuid)
            .HasConstraintName("fk_post_comments_parent").OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<PostLike>()
            .HasOne<UserPost>().WithMany().HasForeignKey(l => l.PostUuid)
            .HasConstraintName("fk_post_likes_post").OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<PostRepost>()
            .HasOne<UserPost>().WithMany().HasForeignKey(r => r.PostUuid)
            .HasConstraintName("fk_post_reposts_post").OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<PostView>()
            .HasOne<UserPost>().WithMany().HasForeignKey(v => v.PostUuid)
            .HasConstraintName("fk_post_views_post").OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<PostImage>()
            .HasOne<UserPost>().WithMany().HasForeignKey(i => i.PostUuid)
            .HasConstraintName("fk_post_images_post").OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<PostVideo>()
            .HasOne<UserPost>().WithMany().HasForeignKey(v => v.PostUuid)
            .HasConstraintName("fk_post_videos_post").OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<CommunityAvatar>()
            .HasOne<Community>().WithMany().HasForeignKey(a => a.CommunityId)
            .HasConstraintName("fk_community_avatars_community").OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<UserCommunity>()
            .HasOne<Community>().WithMany().HasForeignKey(uc => uc.CommunityId)
            .HasConstraintName("fk_user_communities_community").OnDelete(DeleteBehavior.Cascade);
    }
}
