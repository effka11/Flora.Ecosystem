using Flora.Shared;

namespace Flora.Auth.Domain;

public class PendingRegistration
{
    public Guid VerificationToken { get; set; } = FloraUuid.NewGuid();
    public string Email { get; set; } = "";
    public string Username { get; set; } = "";
    public string PasswordHash { get; set; } = "";
    public string VerificationCodeHash { get; set; } = "";
    public DateTime ExpiresAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
