using Microsoft.Extensions.Logging;

namespace Flora.Music.Application.Artists;

public sealed class MusicArtistOrphanCleanupService(
    IMusicArtistRepository artistRepo,
    ILogger<MusicArtistOrphanCleanupService> logger)
{
    public async Task<int> RunAsync(CancellationToken ct = default)
    {
        var cutoff = DateTime.UtcNow - MusicArtistOrphanPolicy.OrphanTtl;
        var deleted = await artistRepo.DeleteOrphanedArtistsAsync(cutoff, ct);
        if (deleted > 0)
        {
            logger.LogInformation(
                "Music artist orphan cleanup: removed {Count} artist(s) without tracks older than {TtlHours} hour(s).",
                deleted,
                MusicArtistOrphanPolicy.OrphanTtl.TotalHours);
        }

        return deleted;
    }
}
