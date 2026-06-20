using Flora.Music.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Flora.Music.Infrastructure;

public class MusicFavoriteConfiguration : IEntityTypeConfiguration<MusicFavorite>
{
    public void Configure(EntityTypeBuilder<MusicFavorite> builder)
    {
        builder.ToTable("music_favorites", "flora_core");
        builder.HasKey(e => new { e.UserUuid, e.TrackUuid }).HasName("pk_music_favorites");
        builder.Property(e => e.UserUuid).HasColumnName("user_uuid");
        builder.Property(e => e.TrackUuid).HasColumnName("track_uuid");
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");

        builder.HasOne(e => e.Track)
            .WithMany()
            .HasForeignKey(e => e.TrackUuid)
            .HasConstraintName("fk_music_favorites_track")
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasIndex(e => new { e.UserUuid, e.CreatedAt })
            .IsDescending(false, true)
            .HasDatabaseName("ix_music_favorites_user_created");
    }
}

public class MusicPlaylistConfiguration : IEntityTypeConfiguration<MusicPlaylist>
{
    public void Configure(EntityTypeBuilder<MusicPlaylist> builder)
    {
        builder.ToTable("music_playlists", "flora_core");
        builder.HasKey(e => e.PlaylistUuid).HasName("pk_music_playlists");
        builder.Property(e => e.PlaylistUuid).HasColumnName("playlist_uuid");
        builder.Property(e => e.OwnerUserUuid).HasColumnName("owner_user_uuid");
        builder.Property(e => e.Title).HasColumnName("title").HasMaxLength(200).IsRequired();
        builder.Property(e => e.CoverColorId).HasColumnName("cover_color_id").HasMaxLength(50).IsRequired();
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");

        builder.HasIndex(e => new { e.OwnerUserUuid, e.CreatedAt })
            .IsDescending(false, true)
            .HasDatabaseName("ix_music_playlists_owner_created");
    }
}

public class MusicPlaylistTrackConfiguration : IEntityTypeConfiguration<MusicPlaylistTrack>
{
    public void Configure(EntityTypeBuilder<MusicPlaylistTrack> builder)
    {
        builder.ToTable("music_playlist_tracks", "flora_core");
        builder.HasKey(e => new { e.PlaylistUuid, e.TrackUuid }).HasName("pk_music_playlist_tracks");
        builder.Property(e => e.PlaylistUuid).HasColumnName("playlist_uuid");
        builder.Property(e => e.TrackUuid).HasColumnName("track_uuid");
        builder.Property(e => e.Position).HasColumnName("position");
        builder.Property(e => e.AddedAt).HasColumnName("added_at").HasDefaultValueSql("CURRENT_TIMESTAMP");

        builder.HasOne(e => e.Playlist)
            .WithMany(p => p.Tracks)
            .HasForeignKey(e => e.PlaylistUuid)
            .HasConstraintName("fk_music_playlist_tracks_playlist")
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(e => e.Track)
            .WithMany()
            .HasForeignKey(e => e.TrackUuid)
            .HasConstraintName("fk_music_playlist_tracks_track")
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasIndex(e => new { e.PlaylistUuid, e.Position })
            .HasDatabaseName("ix_music_playlist_tracks_playlist_position");
    }
}
