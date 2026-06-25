namespace Flora.Notifications.Domain;

public class UserClientPlatform
{
    public Guid UserUuid { get; set; }
    /// <summary>android | ios | web</summary>
    public string Platform { get; set; } = "android";
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
