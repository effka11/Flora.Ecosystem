using Flora.Shared;

namespace Flora.Notifications.Domain;

public class UserPushToken
{
    public Guid PushTokenUuid { get; set; } = FloraUuid.NewGuid();
    public Guid UserUuid { get; set; }
    public string Token { get; set; } = "";
    /// <summary>android | ios</summary>
    public string Platform { get; set; } = "android";
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
