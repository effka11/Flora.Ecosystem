using Flora.Shared;

namespace Flora.Verification.Domain;

/// <summary>
/// A one-time verification challenge owned entirely by the Verification module. The plaintext
/// code is never stored — only its hash. <see cref="Kind"/> is persisted as an int so Domain
/// stays free of the public <c>VerificationChallengeKind</c> enum (which lives in Contracts).
/// </summary>
public class VerificationChallenge
{
    public Guid Token { get; set; } = FloraUuid.NewGuid();
    public int Kind { get; set; }
    public string Target { get; set; } = "";
    public Guid? SubjectUserUuid { get; set; }
    public string CodeHash { get; set; } = "";
    public DateTime ExpiresAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public int Attempts { get; set; }
}
