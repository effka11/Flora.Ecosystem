namespace Flora.Verification.Contracts;

/// <summary>
/// In-process port for issuing and validating one-time verification challenges. Callers (e.g. Auth)
/// depend only on this contract; the Verification module owns all challenge storage and delivery.
/// </summary>
public interface IVerificationChallengeService
{
    Task<ChallengeBeginResult> BeginAsync(
        VerificationChallengeKind kind,
        string target,
        Guid? subjectUserUuid,
        CancellationToken ct);

    Task<ChallengeValidateResult> ValidateAsync(Guid token, string codePlain, CancellationToken ct);

    Task CancelAsync(Guid token, CancellationToken ct);
}
