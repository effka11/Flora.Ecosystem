using Flora.Shared;

namespace Flora.Content.Domain;

public class Community
{
    public Guid CommunityId { get; set; } = FloraUuid.NewGuid();
    public string Name { get; set; } = "";
    public string Slug { get; set; } = "";
    public bool IsPrivate { get; set; } = true;
    public Guid? AvatarUuid { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
