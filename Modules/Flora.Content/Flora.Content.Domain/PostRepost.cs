namespace Flora.Content.Domain;

public class PostRepost
{
    public Guid PostUuid { get; set; }
    public Guid UserUuid { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
