namespace Flora.Content.Domain;

public class PostView
{
    public Guid PostUuid { get; set; }
    public Guid UserUuid { get; set; }
    public DateTime ViewedAt { get; set; } = DateTime.UtcNow;
}
