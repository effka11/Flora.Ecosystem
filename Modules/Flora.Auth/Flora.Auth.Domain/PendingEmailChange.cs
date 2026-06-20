using Flora.Shared;

namespace Flora.Auth.Domain;

public class PendingEmailChange
{
    public Guid ChangeToken { get; set; } = FloraUuid.NewGuid();
    public Guid UserUuid { get; set; }
    public string NewEmail { get; set; } = "";
    public string VerificationCodeHash { get; set; } = "";
    public DateTime ExpiresAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
