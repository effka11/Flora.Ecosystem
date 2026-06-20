using Flora.Shared;

namespace Flora.Content.Domain;

public class UserPost
{
    public Guid PostUuid { get; set; } = FloraUuid.NewGuid();
    public Guid AuthorUserUuid { get; set; }
    public Guid? CommunityId { get; set; }
    public string Content { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public bool IsDeleted { get; set; }
    public DateTime? DeletedAt { get; set; }
}
