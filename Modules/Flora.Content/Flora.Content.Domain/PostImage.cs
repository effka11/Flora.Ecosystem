using Flora.Shared;

namespace Flora.Content.Domain;

public class PostImage
{
    public Guid Uuid { get; set; } = FloraUuid.NewGuid();
    public Guid PostUuid { get; set; }
    public string ContentType { get; set; } = "image/jpeg";
    public byte[] Data { get; set; } = Array.Empty<byte>();
    public int SortOrder { get; set; }
}
