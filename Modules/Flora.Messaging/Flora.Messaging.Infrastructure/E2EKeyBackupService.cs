using Flora.Messaging.Application;
using Flora.Messaging.Contracts;
using Flora.Messaging.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Messaging.Infrastructure;

/// <inheritdoc cref="IE2EKeyBackupService"/>
public sealed class E2EKeyBackupService(MessagingDbContext db) : IE2EKeyBackupService
{
    // ── Helpers ──────────────────────────────────────────────────────────────

    private static string StateToString(E2EAccountStateKind s) => s switch
    {
        E2EAccountStateKind.NotInitialized => "not_initialized",
        E2EAccountStateKind.Active => "active",
        E2EAccountStateKind.Locked => "locked",
        E2EAccountStateKind.ActiveNewEpoch => "active_new_epoch",
        E2EAccountStateKind.Recovering => "recovering",
        E2EAccountStateKind.Rotating => "rotating",
        E2EAccountStateKind.Frozen => "frozen",
        _ => "unknown",
    };

    private static KeyBackupPayload MapBackup(UserE2EKeyBackup b) => new(
        Version: b.Version,
        BackupRevision: b.BackupRevision,
        BackupKeyId: b.BackupKeyId,
        UserUuid: b.UserUuid,
        PrimaryKeyEpochId: b.PrimaryKeyEpochId,
        EpochSetRevision: b.EpochSetRevision,
        EpochSetHashBase64Url: b.EpochSetHashBase64Url,
        Kdf: new KdfParams(b.KdfName, b.KdfMemoryKiB, b.KdfIterations, b.KdfParallelism, b.KdfSaltBase64Url),
        Aead: new AeadParams(b.AeadName, b.AeadNonceBase64Url),
        CiphertextBase64Url: b.CiphertextBase64Url);

    private static RecoveryBackupMeta MapRecoveryMeta(UserE2ERecoveryBackup r) => new(
        RecoveryKeyId: r.RecoveryKeyId,
        RecoveryRevision: r.RecoveryRevision,
        PrimaryKeyEpochId: r.PrimaryKeyEpochId,
        EpochSetRevision: r.EpochSetRevision,
        EpochSetHashBase64Url: r.EpochSetHashBase64Url,
        Wordlist: new WordlistInfo(r.WordlistId, r.WordsCount),
        CreatedAt: r.CreatedAt,
        UpdatedAt: r.UpdatedAt,
        UsedAt: r.UsedAt);

    private static RecoveryBackupPayload MapRecovery(UserE2ERecoveryBackup r) => new(
        Version: r.Version,
        RecoveryRevision: r.RecoveryRevision,
        RecoveryKeyId: r.RecoveryKeyId,
        UserUuid: r.UserUuid,
        PrimaryKeyEpochId: r.PrimaryKeyEpochId,
        EpochSetRevision: r.EpochSetRevision,
        EpochSetHashBase64Url: r.EpochSetHashBase64Url,
        Wordlist: new WordlistInfo(r.WordlistId, r.WordsCount),
        Kdf: new KdfParams(r.KdfName, r.KdfMemoryKiB, r.KdfIterations, r.KdfParallelism, r.KdfSaltBase64Url),
        Aead: new AeadParams(r.AeadName, r.AeadNonceBase64Url),
        CiphertextBase64Url: r.CiphertextBase64Url);

    // ── IService Implementation ───────────────────────────────────────────────

    /// <inheritdoc/>
    public async Task EnsureStateInitializedAsync(Guid userUuid, CancellationToken ct)
    {
        var exists = await db.UserE2EAccountStates.AnyAsync(s => s.UserUuid == userUuid, ct);
        if (!exists)
        {
            db.UserE2EAccountStates.Add(new UserE2EAccountState
            {
                UserUuid = userUuid,
                State = E2EAccountStateKind.NotInitialized,
                Freeze = false,
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow,
            });
            await db.SaveChangesAsync(ct);
        }
    }

    /// <inheritdoc/>
    public async Task<E2EBackupResult<E2EStateResponse>> GetStateAsync(Guid userUuid, CancellationToken ct)
    {
        var state = await db.UserE2EAccountStates.AsNoTracking()
            .FirstOrDefaultAsync(s => s.UserUuid == userUuid, ct);
        if (state is null)
            return E2EBackupResult<E2EStateResponse>.Success(
                new E2EStateResponse("not_initialized", false, DateTime.UtcNow));
        return E2EBackupResult<E2EStateResponse>.Success(
            new E2EStateResponse(StateToString(state.State), state.Freeze, state.UpdatedAt));
    }

    /// <inheritdoc/>
    public async Task<E2EBackupResult<KeyBackupPayload>> GetKeyBackupAsync(Guid userUuid, CancellationToken ct)
    {
        var backup = await db.UserE2EKeyBackups.AsNoTracking()
            .FirstOrDefaultAsync(b => b.UserUuid == userUuid, ct);
        if (backup is null)
            return E2EBackupResult<KeyBackupPayload>.Failure(E2EBackupErrorCode.NotFound, "Key backup not found.");
        return E2EBackupResult<KeyBackupPayload>.Success(MapBackup(backup));
    }

    /// <inheritdoc/>
    public async Task<E2EBackupVoidResult> PutKeyBackupAsync(
        Guid userUuid, PutKeyBackupRequest request, CancellationToken ct)
    {
        // Validate userUuid matches the payload
        if (request.KeyBackup.UserUuid != userUuid)
            return E2EBackupVoidResult.Failure(E2EBackupErrorCode.Forbidden, "userUuid mismatch.");

        await EnsureStateInitializedAsync(userUuid, ct);

        var state = await db.UserE2EAccountStates.FirstOrDefaultAsync(s => s.UserUuid == userUuid, ct);
        if (state!.Freeze)
            return E2EBackupVoidResult.Failure(E2EBackupErrorCode.AccountFrozen, "Account is frozen.");
        if (state.State == E2EAccountStateKind.Locked)
            return E2EBackupVoidResult.Failure(E2EBackupErrorCode.AccountLocked,
                "PUT key-backup is not allowed while account state is locked.");

        // Upsert backup
        var existing = await db.UserE2EKeyBackups.FirstOrDefaultAsync(b => b.UserUuid == userUuid, ct);
        var kb = request.KeyBackup;
        if (existing is null)
        {
            db.UserE2EKeyBackups.Add(new UserE2EKeyBackup
            {
                UserUuid = userUuid,
                Version = kb.Version,
                BackupRevision = kb.BackupRevision,
                BackupKeyId = kb.BackupKeyId,
                PrimaryKeyEpochId = kb.PrimaryKeyEpochId,
                EpochSetRevision = kb.EpochSetRevision,
                EpochSetHashBase64Url = kb.EpochSetHashBase64Url,
                KdfName = kb.Kdf.Name,
                KdfMemoryKiB = kb.Kdf.MemoryKiB,
                KdfIterations = kb.Kdf.Iterations,
                KdfParallelism = kb.Kdf.Parallelism,
                KdfSaltBase64Url = kb.Kdf.SaltBase64Url,
                AeadName = kb.Aead.Name,
                AeadNonceBase64Url = kb.Aead.NonceBase64Url,
                CiphertextBase64Url = kb.CiphertextBase64Url,
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow,
            });
        }
        else
        {
            existing.Version = kb.Version;
            existing.BackupRevision = kb.BackupRevision;
            existing.BackupKeyId = kb.BackupKeyId;
            existing.PrimaryKeyEpochId = kb.PrimaryKeyEpochId;
            existing.EpochSetRevision = kb.EpochSetRevision;
            existing.EpochSetHashBase64Url = kb.EpochSetHashBase64Url;
            existing.KdfName = kb.Kdf.Name;
            existing.KdfMemoryKiB = kb.Kdf.MemoryKiB;
            existing.KdfIterations = kb.Kdf.Iterations;
            existing.KdfParallelism = kb.Kdf.Parallelism;
            existing.KdfSaltBase64Url = kb.Kdf.SaltBase64Url;
            existing.AeadName = kb.Aead.Name;
            existing.AeadNonceBase64Url = kb.Aead.NonceBase64Url;
            existing.CiphertextBase64Url = kb.CiphertextBase64Url;
            existing.UpdatedAt = DateTime.UtcNow;
        }

        // Upsert epoch public identities if supplied
        if (request.EpochIdentityPublicKeys is { Count: > 0 })
        {
            var epochIds = request.EpochIdentityPublicKeys.Select(e => e.KeyEpochId).ToList();
            var existing2 = await db.KeyEpochPublicIdentities
                .Where(e => e.UserUuid == userUuid && epochIds.Contains(e.KeyEpochId))
                .ToListAsync(ct);
            var existingMap = existing2.ToDictionary(e => e.KeyEpochId);

            foreach (var entry in request.EpochIdentityPublicKeys)
            {
                if (existingMap.TryGetValue(entry.KeyEpochId, out var existingEpoch))
                {
                    // Spec: if already stored, must match byte-for-byte
                    if (!string.Equals(existingEpoch.EpochAccountIdentityPublicKeyBase64Url,
                            entry.EpochAccountIdentityPublicKeyBase64Url, StringComparison.Ordinal))
                        return E2EBackupVoidResult.Failure(E2EBackupErrorCode.Conflict,
                            $"Epoch {entry.KeyEpochId}: public key conflicts with already-stored key.");
                }
                else
                {
                    db.KeyEpochPublicIdentities.Add(new KeyEpochPublicIdentity
                    {
                        UserUuid = userUuid,
                        KeyEpochId = entry.KeyEpochId,
                        EpochAccountIdentityPublicKeyBase64Url = entry.EpochAccountIdentityPublicKeyBase64Url,
                        CreatedAt = DateTime.UtcNow,
                        UpdatedAt = DateTime.UtcNow,
                    });
                }
            }
        }

        // Transition state to Active on first backup
        if (state.State == E2EAccountStateKind.NotInitialized)
        {
            state.State = E2EAccountStateKind.Active;
            state.UpdatedAt = DateTime.UtcNow;
        }

        await db.SaveChangesAsync(ct);
        return E2EBackupVoidResult.Ok;
    }

    /// <inheritdoc/>
    public async Task<E2EBackupResult<IReadOnlyList<RecoveryBackupMeta>>> GetRecoveryBackupsAsync(
        Guid userUuid, CancellationToken ct)
    {
        var list = await db.UserE2ERecoveryBackups.AsNoTracking()
            .Where(r => r.UserUuid == userUuid)
            .OrderByDescending(r => r.CreatedAt)
            .ToListAsync(ct);
        return E2EBackupResult<IReadOnlyList<RecoveryBackupMeta>>.Success(
            list.Select(MapRecoveryMeta).ToList());
    }

    /// <inheritdoc/>
    public async Task<E2EBackupResult<RecoveryBackupPayload>> GetRecoveryBackupAsync(
        Guid userUuid, Guid recoveryKeyId, CancellationToken ct)
    {
        var r = await db.UserE2ERecoveryBackups.AsNoTracking()
            .FirstOrDefaultAsync(x => x.UserUuid == userUuid && x.RecoveryKeyId == recoveryKeyId, ct);
        if (r is null)
            return E2EBackupResult<RecoveryBackupPayload>.Failure(E2EBackupErrorCode.NotFound, "Recovery backup not found.");
        return E2EBackupResult<RecoveryBackupPayload>.Success(MapRecovery(r));
    }

    /// <inheritdoc/>
    public async Task<E2EBackupVoidResult> PutRecoveryBackupAsync(
        Guid userUuid, RecoveryBackupPayload payload, CancellationToken ct)
    {
        if (payload.UserUuid != userUuid)
            return E2EBackupVoidResult.Failure(E2EBackupErrorCode.Forbidden, "userUuid mismatch.");

        var existing = await db.UserE2ERecoveryBackups
            .FirstOrDefaultAsync(r => r.UserUuid == userUuid && r.RecoveryKeyId == payload.RecoveryKeyId, ct);

        if (existing is null)
        {
            db.UserE2ERecoveryBackups.Add(new UserE2ERecoveryBackup
            {
                RecoveryKeyId = payload.RecoveryKeyId,
                UserUuid = userUuid,
                Version = payload.Version,
                RecoveryRevision = payload.RecoveryRevision,
                PrimaryKeyEpochId = payload.PrimaryKeyEpochId,
                EpochSetRevision = payload.EpochSetRevision,
                EpochSetHashBase64Url = payload.EpochSetHashBase64Url,
                WordlistId = payload.Wordlist.Id,
                WordsCount = payload.Wordlist.WordsCount,
                KdfName = payload.Kdf.Name,
                KdfMemoryKiB = payload.Kdf.MemoryKiB,
                KdfIterations = payload.Kdf.Iterations,
                KdfParallelism = payload.Kdf.Parallelism,
                KdfSaltBase64Url = payload.Kdf.SaltBase64Url,
                AeadName = payload.Aead.Name,
                AeadNonceBase64Url = payload.Aead.NonceBase64Url,
                CiphertextBase64Url = payload.CiphertextBase64Url,
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow,
            });
        }
        else
        {
            existing.Version = payload.Version;
            existing.RecoveryRevision = payload.RecoveryRevision;
            existing.PrimaryKeyEpochId = payload.PrimaryKeyEpochId;
            existing.EpochSetRevision = payload.EpochSetRevision;
            existing.EpochSetHashBase64Url = payload.EpochSetHashBase64Url;
            existing.WordlistId = payload.Wordlist.Id;
            existing.WordsCount = payload.Wordlist.WordsCount;
            existing.KdfName = payload.Kdf.Name;
            existing.KdfMemoryKiB = payload.Kdf.MemoryKiB;
            existing.KdfIterations = payload.Kdf.Iterations;
            existing.KdfParallelism = payload.Kdf.Parallelism;
            existing.KdfSaltBase64Url = payload.Kdf.SaltBase64Url;
            existing.AeadName = payload.Aead.Name;
            existing.AeadNonceBase64Url = payload.Aead.NonceBase64Url;
            existing.CiphertextBase64Url = payload.CiphertextBase64Url;
            existing.UpdatedAt = DateTime.UtcNow;
        }

        await db.SaveChangesAsync(ct);
        return E2EBackupVoidResult.Ok;
    }

    /// <inheritdoc/>
    public async Task<E2EBackupVoidResult> LockAsync(Guid userUuid, CancellationToken ct)
    {
        var state = await db.UserE2EAccountStates.FirstOrDefaultAsync(s => s.UserUuid == userUuid, ct);
        if (state is null) return E2EBackupVoidResult.Ok; // no-op if not initialized

        // Idempotent: already locked
        if (state.State == E2EAccountStateKind.Locked) return E2EBackupVoidResult.Ok;

        state.State = E2EAccountStateKind.Locked;
        state.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return E2EBackupVoidResult.Ok;
    }
}
