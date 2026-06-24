using Flora.Shared;

namespace Flora.Auth.Domain;

/// <summary>
/// A draft account awaiting email verification. The verification code itself is owned by the
/// Verification module; this row only holds account material keyed by the challenge token.
/// <see cref="ExpiresAt"/> bounds the draft locally (TTL cleanup) so it can never become eternal.
/// </summary>
public class PendingRegistration
{
    public Guid VerificationToken { get; set; } = FloraUuid.NewGuid();
    public string Email { get; set; } = "";
    public string Username { get; set; } = "";
    public string PasswordHash { get; set; } = "";
    public DateTime ExpiresAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
