namespace Flora.Messaging.Domain;

/// <summary>
/// Idempotency record for critical E2E mutation operations (POST epochs, unlock-complete, PUT recovery-backup).
/// Prevents replay attacks and double-writes.
/// Maps to table <c>user_e2e_idempotency_records</c>.
/// </summary>
public sealed class UserE2EIdempotencyRecord
{
    public Guid IdempotencyKey { get; set; }
    public Guid UserUuid { get; set; }

    /// <summary>Operation label, e.g. "epochs", "unlock-complete", "recovery-backup".</summary>
    public string Operation { get; set; } = "";

    /// <summary>
    /// SHA-256 hex of the canonical request body (used to detect
    /// idempotent replay vs conflicting re-use of the same key).
    /// </summary>
    public string RequestBodyHash { get; set; } = "";

    public DateTime CreatedAt { get; set; }

    /// <summary>TTL-based expiry — background service purges expired records.</summary>
    public DateTime ExpiresAt { get; set; }
}
