namespace Flora.Users.Domain;

public class UserPresence
{
    public Guid UserUuid { get; set; }
    public DateTime LastSeenAtUtc { get; set; } = DateTime.UtcNow;
}
