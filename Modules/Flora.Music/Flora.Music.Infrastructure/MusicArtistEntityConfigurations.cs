using Flora.Music.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Flora.Music.Infrastructure;

public class MusicArtistConfiguration : IEntityTypeConfiguration<MusicArtist>
{
    public void Configure(EntityTypeBuilder<MusicArtist> builder)
    {
        builder.ToTable("music_artists", "flora_core");
        builder.HasKey(e => e.ArtistUuid).HasName("pk_music_artists");
        builder.Property(e => e.ArtistUuid).HasColumnName("artist_uuid");
        builder.Property(e => e.DisplayName).HasColumnName("display_name").HasMaxLength(200).IsRequired();
        builder.Property(e => e.NormalizedDisplayName).HasColumnName("normalized_display_name").HasMaxLength(200).IsRequired();
        builder.Property(e => e.TracksCount).HasColumnName("tracks_count");
        builder.Property(e => e.LinkedUserUuid).HasColumnName("linked_user_uuid");
        builder.Property(e => e.CreatedByUserUuid).HasColumnName("created_by_user_uuid");
        builder.Property(e => e.CoverData).HasColumnName("cover_data");
        builder.Property(e => e.CoverContentType).HasColumnName("cover_content_type").HasMaxLength(100);
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");

        builder.HasIndex(e => e.NormalizedDisplayName).HasDatabaseName("ix_music_artists_normalized_display_name");
        builder.HasIndex(e => e.LinkedUserUuid)
            .IsUnique()
            .HasFilter("linked_user_uuid IS NOT NULL")
            .HasDatabaseName("ix_music_artists_linked_user");
    }
}

public class MusicTrackArtistConfiguration : IEntityTypeConfiguration<MusicTrackArtist>
{
    public void Configure(EntityTypeBuilder<MusicTrackArtist> builder)
    {
        builder.ToTable("music_track_artists", "flora_core");
        builder.HasKey(e => e.MusicTrackArtistUuid).HasName("pk_music_track_artists");
        builder.Property(e => e.MusicTrackArtistUuid).HasColumnName("music_track_artist_uuid");
        builder.Property(e => e.TrackUuid).HasColumnName("track_uuid");
        builder.Property(e => e.ArtistUuid).HasColumnName("artist_uuid");
        builder.Property(e => e.Role).HasColumnName("role");
        builder.Property(e => e.JoinerBefore).HasColumnName("joiner_before");
        builder.Property(e => e.SortOrder).HasColumnName("sort_order");

        builder.HasIndex(e => new { e.TrackUuid, e.SortOrder })
            .IsUnique()
            .HasDatabaseName("uq_music_track_artists_track_sort");

        builder.HasIndex(e => e.ArtistUuid).HasDatabaseName("ix_music_track_artists_artist");
        builder.HasIndex(e => e.TrackUuid).HasDatabaseName("ix_music_track_artists_track");
        builder.HasIndex(e => new { e.TrackUuid, e.ArtistUuid }).HasDatabaseName("ix_music_track_artists_track_artist");

        builder.HasOne(e => e.Track)
            .WithMany()
            .HasForeignKey(e => e.TrackUuid)
            .HasConstraintName("fk_music_track_artists_track")
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(e => e.Artist)
            .WithMany()
            .HasForeignKey(e => e.ArtistUuid)
            .HasConstraintName("fk_music_track_artists_artist")
            .OnDelete(DeleteBehavior.Cascade);
    }
}
