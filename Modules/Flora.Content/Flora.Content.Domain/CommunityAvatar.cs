namespace Flora.Content.Domain;

public class CommunityAvatar
{
    public Guid Uuid { get; set; }
    public Guid CommunityId { get; set; }
    public string ContentType { get; set; } = "image/jpeg";
    public byte[] Data { get; set; } = Array.Empty<byte>();
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
