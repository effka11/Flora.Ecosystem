namespace Flora.Content.Domain;

public class PostLike
{
    public Guid PostUuid { get; set; }
    public Guid UserUuid { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
