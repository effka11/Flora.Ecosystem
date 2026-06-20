using Flora.Shared;

namespace Flora.Content.Domain;

public class PostDraft
{
    public Guid DraftUuid { get; set; } = FloraUuid.NewGuid();
    public Guid AuthorUserUuid { get; set; }
    public Guid? CommunityId { get; set; }
    public string Label { get; set; } = "";
    public string Content { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
