using Flora.Messaging.Contracts;

namespace Flora.Messaging.Application;

/// <summary>Error codes for epoch and unlock-complete operations.</summary>
public enum E2EEpochErrorCode
{
    Ok,
    NotFound,
    Forbidden,
    AccountNotInRequiredState,
    IdempotencyConflict,
    SignatureInvalid,
    ChallengeExpiredOrUsed,
    RecoveredEpochsEmpty,
    EpochSetHashUnchanged,
    Conflict,
}

public sealed record E2EEpochResult<T>(E2EEpochErrorCode Code, T? Value, string? Error = null)
{
    public bool IsSuccess => Code == E2EEpochErrorCode.Ok;
    public static E2EEpochResult<T> Success(T value) => new(E2EEpochErrorCode.Ok, value);
    public static E2EEpochResult<T> Failure(E2EEpochErrorCode code, string error) => new(code, default, error);
}

public sealed record E2EEpochVoidResult(E2EEpochErrorCode Code, string? Error = null)
{
    public bool IsSuccess => Code == E2EEpochErrorCode.Ok;
    public static readonly E2EEpochVoidResult Ok = new(E2EEpochErrorCode.Ok);
    public static E2EEpochVoidResult Failure(E2EEpochErrorCode code, string error) => new(code, error);
}

/// <summary>
/// Application service for epoch management and unlock-complete flow.
/// Enforces FSM rules from docs/fscp/e2e-security.md §Create epoch contract and §Unlock-complete contract.
/// </summary>
public interface IE2EEpochService
{
    /// <summary>
    /// Creates a new key epoch.
    /// Allowed only when account state = Locked.
    /// Idempotent if same idempotencyKey + identical body.
    /// After success, transitions to ActiveNewEpoch.
    /// </summary>
    Task<E2EEpochVoidResult> CreateEpochAsync(
        Guid userUuid,
        CreateEpochRequest request,
        CancellationToken ct);

    /// <summary>
    /// Issues a short-lived challenge for unlock-complete signing.
    /// Allowed only when account state = Recovering.
    /// Returns challengeId, resetRequestId, canonical payload preview.
    /// </summary>
    Task<E2EEpochResult<UnlockChallengeResponse>> RequestUnlockChallengeAsync(
        Guid userUuid,
        CancellationToken ct);

    /// <summary>
    /// Completes an E2E unlock/recovery:
    ///   - Verifies signatures (epochUnlockSignatures) against stored KeyEpochPublicIdentity.
    ///   - Verifies challengeId is valid, not expired, not already used.
    ///   - Atomically replaces password backup, upserts KeyEpochPublicIdentity, transitions to Active.
    /// Allowed only when account state = Recovering.
    /// </summary>
    Task<E2EEpochVoidResult> UnlockCompleteAsync(
        Guid userUuid,
        UnlockCompleteRequest request,
        CancellationToken ct);

    /// <summary>
    /// Registers a new device public key pair for the epoch as Pending.
    /// Allowed when account state is Active or ActiveNewEpoch.
    /// </summary>
    Task<E2EEpochResult<AddPendingDeviceResponse>> AddPendingDeviceAsync(
        Guid userUuid,
        Guid keyEpochId,
        AddPendingDeviceRequest request,
        CancellationToken ct);

    /// <summary>
    /// Returns all device key entries for the given epoch.
    /// </summary>
    Task<E2EEpochResult<IReadOnlyList<DeviceKeyEntry>>> GetDevicesAsync(
        Guid userUuid,
        Guid keyEpochId,
        CancellationToken ct);

    /// <summary>
    /// Revokes a device key. Idempotent if already revoked.
    /// </summary>
    Task<E2EEpochVoidResult> RevokeDeviceAsync(
        Guid userUuid,
        Guid keyEpochId,
        Guid deviceUuid,
        CancellationToken ct);
}
