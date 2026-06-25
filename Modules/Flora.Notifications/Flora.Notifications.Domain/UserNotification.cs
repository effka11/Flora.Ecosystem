using Flora.Shared;

namespace Flora.Notifications.Domain;

public class UserNotification
{
    public Guid NotificationUuid { get; set; } = FloraUuid.NewGuid();
    public Guid RecipientUserUuid { get; set; }
    public Guid? ActorUserUuid { get; set; }
    /// <summary>like | reply | follow | developer | default</summary>
    public string Type { get; set; } = "default";
    /// <summary>social | developer</summary>
    public string Category { get; set; } = "social";
    public string Text { get; set; } = "";
    /// <summary>null = all clients; android | ios | web = visible only on that client.</summary>
    public string? TargetPlatform { get; set; }
    public Guid? PostUuid { get; set; }
    public Guid? CommentUuid { get; set; }
    public bool IsRead { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
