using Flora.Messaging.Contracts;

namespace Flora.Messaging.Application;

/// <summary>Error codes for E2E key backup operations.</summary>
public enum E2EBackupErrorCode
{
    Ok,
    NotFound,
    Forbidden,
    AccountLocked,
    AccountFrozen,
    Conflict,
}

public sealed record E2EBackupResult<T>(E2EBackupErrorCode Code, T? Value, string? Error = null)
{
    public bool IsSuccess => Code == E2EBackupErrorCode.Ok;
    public static E2EBackupResult<T> Success(T value) => new(E2EBackupErrorCode.Ok, value);
    public static E2EBackupResult<T> Failure(E2EBackupErrorCode code, string error) => new(code, default, error);
}

public sealed record E2EBackupVoidResult(E2EBackupErrorCode Code, string? Error = null)
{
    public bool IsSuccess => Code == E2EBackupErrorCode.Ok;
    public static readonly E2EBackupVoidResult Ok = new(E2EBackupErrorCode.Ok);
    public static E2EBackupVoidResult Failure(E2EBackupErrorCode code, string error) => new(code, error);
}

/// <summary>
/// Application service for E2E key backup operations.
/// Enforces FSM state checks from docs/fscp/e2e-security.md.
/// </summary>
public interface IE2EKeyBackupService
{
    Task<E2EBackupResult<E2EStateResponse>> GetStateAsync(Guid userUuid, CancellationToken ct);

    Task<E2EBackupResult<KeyBackupPayload>> GetKeyBackupAsync(Guid userUuid, CancellationToken ct);

    /// <summary>
    /// Stores the user's password-encrypted key backup.
    /// Rejected when: state = locked, freeze = true.
    /// Upserts EpochPublicIdentities when epochIdentityPublicKeys is supplied.
    /// </summary>
    Task<E2EBackupVoidResult> PutKeyBackupAsync(
        Guid userUuid,
        PutKeyBackupRequest request,
        CancellationToken ct);

    Task<E2EBackupResult<IReadOnlyList<RecoveryBackupMeta>>> GetRecoveryBackupsAsync(
        Guid userUuid, CancellationToken ct);

    Task<E2EBackupResult<RecoveryBackupPayload>> GetRecoveryBackupAsync(
        Guid userUuid, Guid recoveryKeyId, CancellationToken ct);

    Task<E2EBackupVoidResult> PutRecoveryBackupAsync(
        Guid userUuid, RecoveryBackupPayload payload, CancellationToken ct);

    /// <summary>Transitions the E2E account state to Locked. Idempotent.</summary>
    Task<E2EBackupVoidResult> LockAsync(Guid userUuid, CancellationToken ct);

    /// <summary>
    /// Ensures a state row exists for the user (upsert NotInitialized).
    /// Called lazily on first PUT key-backup if no state row exists.
    /// </summary>
    Task EnsureStateInitializedAsync(Guid userUuid, CancellationToken ct);
}
