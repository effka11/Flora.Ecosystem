using Flora.Music.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Music.Infrastructure;

public class MusicDbContext : DbContext
{
    public MusicDbContext(DbContextOptions<MusicDbContext> options) : base(options) { }

    public DbSet<MusicTrack> MusicTracks => Set<MusicTrack>();
    public DbSet<MusicFavorite> MusicFavorites => Set<MusicFavorite>();
    public DbSet<MusicPlaylist> MusicPlaylists => Set<MusicPlaylist>();
    public DbSet<MusicPlaylistTrack> MusicPlaylistTracks => Set<MusicPlaylistTrack>();
    public DbSet<MusicArtist> MusicArtists => Set<MusicArtist>();
    public DbSet<MusicTrackArtist> MusicTrackArtists => Set<MusicTrackArtist>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);
        modelBuilder.HasDefaultSchema("flora_core");
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(MusicDbContext).Assembly);
    }
}
