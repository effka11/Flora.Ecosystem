namespace Flora.Verification.Contracts;

/// <summary>What a challenge authorizes, so callers can reuse one module for several flows.</summary>
public enum VerificationChallengeKind
{
    EmailRegistration = 0,
    EmailChange = 1,
}

/// <summary>
/// Result of starting a challenge. <see cref="DevCode"/> is populated only in Development so local
/// flows can complete without a real mailbox; it is always null outside Development.
/// </summary>
public sealed record ChallengeBeginResult(Guid Token, DateTime ExpiresAtUtc, string? DevCode);

public enum ChallengeValidateStatus
{
    Success = 0,
    NotFound = 1,
    Expired = 2,
    CodeMismatch = 3,
}

/// <summary>
/// Result of validating a code. On <see cref="ChallengeValidateStatus.Success"/> the original
/// <see cref="Target"/> and <see cref="SubjectUserUuid"/> are returned so the caller can act on
/// the verified value without re-storing it.
/// </summary>
public sealed record ChallengeValidateResult(
    ChallengeValidateStatus Status,
    string? Target,
    Guid? SubjectUserUuid)
{
    public bool Success => Status == ChallengeValidateStatus.Success;
}
