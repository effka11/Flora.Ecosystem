namespace Flora.Auth.Domain;

public class UserSecurityLogs
{
    public Guid UserUuid { get; set; }
    public DateTime? LastLogin { get; set; }
    public DateTime PasswordUpdatedAt { get; set; } = DateTime.UtcNow;
    public byte LoginFailures { get; set; }
    public DateTime? LoginLockedUntil { get; set; }
    public DateTime? PrivacyAcceptedAt { get; set; }
    public DateTime? TosAcceptedAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
