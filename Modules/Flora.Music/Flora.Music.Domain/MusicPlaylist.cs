using Flora.Shared;

namespace Flora.Music.Domain;

public class MusicPlaylist
{
    public Guid PlaylistUuid { get; set; } = FloraUuid.NewGuid();
    public Guid OwnerUserUuid { get; set; }
    public string Title { get; set; } = string.Empty;
    public string CoverColorId { get; set; } = "forest";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public ICollection<MusicPlaylistTrack> Tracks { get; set; } = [];
}
