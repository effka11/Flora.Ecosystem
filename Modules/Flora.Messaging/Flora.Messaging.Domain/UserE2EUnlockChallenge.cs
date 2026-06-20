namespace Flora.Messaging.Domain;

/// <summary>
/// Short-lived challenge record issued by POST /api/messaging/e2e/unlock-complete/challenge.
/// Binds challengeId + resetRequestId for one recovery/merge session.
/// Maps to table <c>user_e2e_unlock_challenges</c>.
/// </summary>
public sealed class UserE2EUnlockChallenge
{
    public Guid ChallengeId { get; set; }
    public Guid UserUuid { get; set; }

    /// <summary>Fresh reset / recovery session id, matches the recovery flow's resetRequestId.</summary>
    public Guid ResetRequestId { get; set; }

    /// <summary>Human-readable canonical payload preview sent to the client for display.</summary>
    public string CanonicalPayloadPreview { get; set; } = "";

    public DateTime ExpiresAt { get; set; }
    public bool IsUsed { get; set; }
    public DateTime CreatedAt { get; set; }
}
