using Flora.Music.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Flora.Music.Infrastructure;

public class MusicTrackConfiguration : IEntityTypeConfiguration<MusicTrack>
{
    public void Configure(EntityTypeBuilder<MusicTrack> builder)
    {
        builder.ToTable("music_tracks", "flora_core");
        builder.HasKey(e => e.TrackUuid).HasName("pk_music_tracks");
        builder.Property(e => e.TrackUuid).HasColumnName("track_uuid");
        builder.Property(e => e.OwnerUserUuid).HasColumnName("owner_user_uuid");
        builder.Property(e => e.Scope).HasColumnName("scope");
        builder.Property(e => e.Title).HasColumnName("title").HasMaxLength(300).IsRequired();
        builder.Property(e => e.ArtistDisplay).HasColumnName("artist_display").HasMaxLength(500).IsRequired();
        builder.Property(e => e.Tags).HasColumnName("tags").HasMaxLength(1000);
        builder.Property(e => e.GenreId).HasColumnName("genre_id").HasMaxLength(100);
        builder.Property(e => e.LicenseId).HasColumnName("license_id").HasMaxLength(50);
        builder.Property(e => e.CoverColorId).HasColumnName("cover_color_id").HasMaxLength(50);
        builder.Property(e => e.TrackKindId).HasColumnName("track_kind_id").HasMaxLength(50);
        builder.Property(e => e.CoverData).HasColumnName("cover_data");
        builder.Property(e => e.CoverContentType).HasColumnName("cover_content_type").HasMaxLength(100);
        builder.Property(e => e.ContentType).HasColumnName("content_type").HasMaxLength(100).IsRequired();
        builder.Property(e => e.AudioData).HasColumnName("audio_data").IsRequired();
        builder.Property(e => e.DurationMs).HasColumnName("duration_ms");
        builder.Property(e => e.FileSizeBytes).HasColumnName("file_size_bytes");
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(e => e.PublishedAt).HasColumnName("published_at");

        builder.HasIndex(e => new { e.OwnerUserUuid, e.CreatedAt })
            .IsDescending(false, true)
            .HasDatabaseName("ix_music_tracks_owner_created");
    }
}
