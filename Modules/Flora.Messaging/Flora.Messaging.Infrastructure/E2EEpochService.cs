using System.Security.Cryptography;
using System.Text;
using Flora.Messaging.Application;
using Flora.Messaging.Contracts;
using Flora.Messaging.Domain;
using Microsoft.EntityFrameworkCore;
using NSec.Cryptography;

namespace Flora.Messaging.Infrastructure;

/// <inheritdoc cref="IE2EEpochService"/>
public sealed class E2EEpochService(MessagingDbContext db) : IE2EEpochService
{
    // ── Challenge TTL ────────────────────────────────────────────────────────
    private static readonly TimeSpan ChallengeTtl = TimeSpan.FromMinutes(15);

    // ── Canonical strings ────────────────────────────────────────────────────

    /// <summary>
    /// Builds the canonical payload string for unlock-complete Ed25519 signing.
    /// flora.messaging.unlock-complete.v1 | userUuid | resetRequestId | challengeId |
    ///   backupKeyId | backupRevision | epochSetHashBase64Url | recoveredKeyEpochIds_sorted
    /// </summary>
    private static string BuildCanonicalUnlockPayload(
        Guid userUuid,
        Guid resetRequestId,
        Guid challengeId,
        Guid backupKeyId,
        int backupRevision,
        string epochSetHashBase64Url,
        IEnumerable<Guid> recoveredKeyEpochIds)
    {
        var sortedIds = string.Join(",", recoveredKeyEpochIds.OrderBy(x => x).Select(x => x.ToString()));
        return $"flora.messaging.unlock-complete.v1 | {userUuid} | {resetRequestId} | {challengeId} | " +
               $"{backupKeyId} | {backupRevision} | {epochSetHashBase64Url} | {sortedIds}";
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private static string FromBase64Url(string base64Url)
    {
        var s = base64Url.Replace('-', '+').Replace('_', '/');
        switch (s.Length % 4)
        {
            case 2: s += "=="; break;
            case 3: s += "="; break;
        }
        return s;
    }

    private static byte[] DecodeBase64Url(string base64Url) =>
        Convert.FromBase64String(FromBase64Url(base64Url));

    private static string ComputeBodyHash(string json)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(json));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    private static bool VerifyEd25519Signature(
        string publicKeyBase64Url,
        string message,
        string signatureBase64Url)
    {
        try
        {
            var pkBytes = DecodeBase64Url(publicKeyBase64Url);
            var sigBytes = DecodeBase64Url(signatureBase64Url);
            var msgBytes = Encoding.UTF8.GetBytes(message);

            var publicKey = PublicKey.Import(
                SignatureAlgorithm.Ed25519, pkBytes, KeyBlobFormat.RawPublicKey);

            return SignatureAlgorithm.Ed25519.Verify(publicKey, msgBytes, sigBytes);
        }
        catch
        {
            return false;
        }
    }

    private static DeviceKeyEntry MapDevice(UserDeviceKey d) => new(
        DeviceUuid: d.DeviceUuid,
        KeyEpochId: d.KeyEpochId,
        DisplayName: d.DisplayName,
        SigningPublicKeyBase64Url: d.SigningPublicKeyBase64Url,
        AgreementPublicKeyBase64Url: d.AgreementPublicKeyBase64Url,
        Status: d.Status.ToString().ToLowerInvariant(),
        CreatedAt: d.CreatedAt,
        LastSeenAt: d.LastSeenAt,
        RevokedAt: d.RevokedAt);

    // ── Idempotency ──────────────────────────────────────────────────────────

    /// <summary>
    /// Returns true if the request was already committed with the SAME body hash (idempotent replay).
    /// Returns false if the key is new.
    /// Throws / returns error code if key exists with DIFFERENT body hash (conflict).
    /// </summary>
    private async Task<(bool alreadyDone, E2EEpochVoidResult? conflict)> CheckIdempotencyAsync(
        Guid idempotencyKey, Guid userUuid, string operation, string bodyHash, CancellationToken ct)
    {
        var existing = await db.UserE2EIdempotencyRecords
            .AsNoTracking()
            .FirstOrDefaultAsync(r => r.IdempotencyKey == idempotencyKey, ct);

        if (existing is null) return (false, null);

        if (existing.UserUuid != userUuid || existing.Operation != operation)
            return (false, E2EEpochVoidResult.Failure(E2EEpochErrorCode.IdempotencyConflict,
                "Idempotency key belongs to a different user or operation."));

        if (!string.Equals(existing.RequestBodyHash, bodyHash, StringComparison.OrdinalIgnoreCase))
            return (false, E2EEpochVoidResult.Failure(E2EEpochErrorCode.IdempotencyConflict,
                "Idempotency key was already used with a different request body."));

        return (true, null); // idempotent replay — safe to return success
    }

    private async Task RecordIdempotencyAsync(
        Guid idempotencyKey, Guid userUuid, string operation, string bodyHash, CancellationToken ct)
    {
        db.UserE2EIdempotencyRecords.Add(new UserE2EIdempotencyRecord
        {
            IdempotencyKey = idempotencyKey,
            UserUuid = userUuid,
            Operation = operation,
            RequestBodyHash = bodyHash,
            CreatedAt = DateTime.UtcNow,
            ExpiresAt = DateTime.UtcNow.AddDays(7),
        });
        await db.SaveChangesAsync(ct);
    }

    // ── IE2EEpochService ─────────────────────────────────────────────────────

    /// <inheritdoc/>
    public async Task<E2EEpochVoidResult> CreateEpochAsync(
        Guid userUuid, CreateEpochRequest request, CancellationToken ct)
    {
        // FSM check: must be Locked
        var state = await db.UserE2EAccountStates.FirstOrDefaultAsync(s => s.UserUuid == userUuid, ct);
        if (state is null || state.State != E2EAccountStateKind.Locked)
        {
            var currentState = state?.State.ToString().ToLowerInvariant() ?? "not_initialized";
            return E2EEpochVoidResult.Failure(
                E2EEpochErrorCode.AccountNotInRequiredState,
                $"POST epochs is only allowed when account state = locked. Current: {currentState}");
        }

        // Idempotency
        var bodyHash = ComputeBodyHash(
            $"{request.IdempotencyKey}:{request.NewKeyEpochId}:{request.NewEpochAccountIdentityPublicKeyBase64Url}");
        var (alreadyDone, conflict) = await CheckIdempotencyAsync(
            request.IdempotencyKey, userUuid, "epochs", bodyHash, ct);
        if (conflict is not null) return conflict;
        if (alreadyDone) return E2EEpochVoidResult.Ok;

        // Ensure newKeyEpochId doesn't already exist as an ACTIVE epoch identity
        var epochExists = await db.KeyEpochPublicIdentities
            .AnyAsync(e => e.UserUuid == userUuid && e.KeyEpochId == request.NewKeyEpochId, ct);
        if (epochExists)
            return E2EEpochVoidResult.Failure(E2EEpochErrorCode.Conflict,
                "The provided newKeyEpochId already exists as an active epoch for this user.");

        var now = DateTime.UtcNow;

        // Upsert password backup (replacing locked-epoch backup)
        var existingBackup = await db.UserE2EKeyBackups.FirstOrDefaultAsync(b => b.UserUuid == userUuid, ct);
        var kb = request.KeyBackup;

        if (existingBackup is null)
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
                CreatedAt = now,
                UpdatedAt = now,
            });
        }
        else
        {
            // Monotonic revision check
            if (kb.BackupRevision <= existingBackup.BackupRevision)
                return E2EEpochVoidResult.Failure(E2EEpochErrorCode.Conflict,
                    "keyBackup.backupRevision must be greater than the current revision.");

            existingBackup.Version = kb.Version;
            existingBackup.BackupRevision = kb.BackupRevision;
            existingBackup.BackupKeyId = kb.BackupKeyId;
            existingBackup.PrimaryKeyEpochId = kb.PrimaryKeyEpochId;
            existingBackup.EpochSetRevision = kb.EpochSetRevision;
            existingBackup.EpochSetHashBase64Url = kb.EpochSetHashBase64Url;
            existingBackup.KdfName = kb.Kdf.Name;
            existingBackup.KdfMemoryKiB = kb.Kdf.MemoryKiB;
            existingBackup.KdfIterations = kb.Kdf.Iterations;
            existingBackup.KdfParallelism = kb.Kdf.Parallelism;
            existingBackup.KdfSaltBase64Url = kb.Kdf.SaltBase64Url;
            existingBackup.AeadName = kb.Aead.Name;
            existingBackup.AeadNonceBase64Url = kb.Aead.NonceBase64Url;
            existingBackup.CiphertextBase64Url = kb.CiphertextBase64Url;
            existingBackup.UpdatedAt = now;
        }

        // Insert epoch public identity
        db.KeyEpochPublicIdentities.Add(new KeyEpochPublicIdentity
        {
            UserUuid = userUuid,
            KeyEpochId = request.NewKeyEpochId,
            EpochAccountIdentityPublicKeyBase64Url = request.NewEpochAccountIdentityPublicKeyBase64Url,
            CreatedAt = now,
            UpdatedAt = now,
        });

        // Register the device that initiated epoch creation as Active
        var deviceUuid = Guid.NewGuid();
        db.UserDeviceKeys.Add(new UserDeviceKey
        {
            DeviceUuid = deviceUuid,
            UserUuid = userUuid,
            KeyEpochId = request.NewKeyEpochId,
            DisplayName = request.NewDeviceDisplayName ?? "",
            SigningPublicKeyBase64Url = request.NewDeviceSigningPublicKeyBase64Url,
            AgreementPublicKeyBase64Url = request.NewDeviceAgreementPublicKeyBase64Url,
            Status = DeviceKeyStatus.Active,
            CreatedAt = now,
        });

        // Transition state: locked → active_new_epoch
        state.State = E2EAccountStateKind.ActiveNewEpoch;
        state.UpdatedAt = now;

        await db.SaveChangesAsync(ct);

        // Record idempotency after commit
        await RecordIdempotencyAsync(request.IdempotencyKey, userUuid, "epochs", bodyHash, ct);

        return E2EEpochVoidResult.Ok;
    }

    /// <inheritdoc/>
    public async Task<E2EEpochResult<UnlockChallengeResponse>> RequestUnlockChallengeAsync(
        Guid userUuid, CancellationToken ct)
    {
        var state = await db.UserE2EAccountStates.AsNoTracking()
            .FirstOrDefaultAsync(s => s.UserUuid == userUuid, ct);

        if (state is null || state.State != E2EAccountStateKind.Recovering)
            return E2EEpochResult<UnlockChallengeResponse>.Failure(
                E2EEpochErrorCode.AccountNotInRequiredState,
                "unlock-complete/challenge is only allowed when account state = recovering.");

        var existingBackup = await db.UserE2EKeyBackups.AsNoTracking()
            .FirstOrDefaultAsync(b => b.UserUuid == userUuid, ct);

        var challengeId = Guid.NewGuid();
        var resetRequestId = Guid.NewGuid();
        var expiresAt = DateTime.UtcNow.Add(ChallengeTtl);

        // Build canonical payload preview for display
        var preview = $"flora.messaging.unlock-complete.v1 | {userUuid} | {resetRequestId} | {challengeId} | " +
                      $"<backupKeyId> | <backupRevision> | <epochSetHashBase64Url> | <recoveredKeyEpochIds_sorted>";

        db.UserE2EUnlockChallenges.Add(new UserE2EUnlockChallenge
        {
            ChallengeId = challengeId,
            UserUuid = userUuid,
            ResetRequestId = resetRequestId,
            CanonicalPayloadPreview = preview,
            ExpiresAt = expiresAt,
            IsUsed = false,
            CreatedAt = DateTime.UtcNow,
        });
        await db.SaveChangesAsync(ct);

        return E2EEpochResult<UnlockChallengeResponse>.Success(
            new UnlockChallengeResponse(challengeId, resetRequestId, expiresAt, preview));
    }

    /// <inheritdoc/>
    public async Task<E2EEpochVoidResult> UnlockCompleteAsync(
        Guid userUuid, UnlockCompleteRequest request, CancellationToken ct)
    {
        // FSM: must be Recovering
        var state = await db.UserE2EAccountStates.FirstOrDefaultAsync(s => s.UserUuid == userUuid, ct);
        if (state is null || state.State != E2EAccountStateKind.Recovering)
            return E2EEpochVoidResult.Failure(
                E2EEpochErrorCode.AccountNotInRequiredState,
                "unlock-complete is only allowed when account state = recovering.");

        // recoveredKeyEpochIds must not be empty
        if (request.RecoveredKeyEpochIds.Count == 0)
            return E2EEpochVoidResult.Failure(
                E2EEpochErrorCode.RecoveredEpochsEmpty,
                "recoveredKeyEpochIds must contain at least one epoch ID. " +
                "(messaging.e2e.unlock_complete.recovered_epochs_empty)");

        // Arrays must be consistent: recoveredKeyEpochIds ↔ epochIdentityPublicKeys ↔ epochUnlockSignatures
        var recoveredSet = request.RecoveredKeyEpochIds.ToHashSet();
        var identitySet = request.EpochIdentityPublicKeys.Select(e => e.KeyEpochId).ToHashSet();
        var sigSet = request.EpochUnlockSignatures.Select(e => e.KeyEpochId).ToHashSet();

        if (!recoveredSet.SetEquals(identitySet) || !recoveredSet.SetEquals(sigSet))
            return E2EEpochVoidResult.Failure(E2EEpochErrorCode.Conflict,
                "recoveredKeyEpochIds, epochIdentityPublicKeys, and epochUnlockSignatures must cover exactly the same set of keyEpochIds.");

        // Validate challenge
        var challenge = await db.UserE2EUnlockChallenges
            .FirstOrDefaultAsync(c => c.ChallengeId == request.ChallengeId && c.UserUuid == userUuid, ct);

        if (challenge is null)
            return E2EEpochVoidResult.Failure(E2EEpochErrorCode.ChallengeExpiredOrUsed,
                "Challenge not found.");
        if (challenge.IsUsed)
            return E2EEpochVoidResult.Failure(E2EEpochErrorCode.ChallengeExpiredOrUsed,
                "Challenge has already been used.");
        if (DateTime.UtcNow > challenge.ExpiresAt)
            return E2EEpochVoidResult.Failure(E2EEpochErrorCode.ChallengeExpiredOrUsed,
                "Challenge has expired.");
        if (challenge.ResetRequestId != request.ResetRequestId)
            return E2EEpochVoidResult.Failure(E2EEpochErrorCode.ChallengeExpiredOrUsed,
                "challengeId does not match resetRequestId.");

        // One of proof tokens must be present
        if (string.IsNullOrEmpty(request.RecoveryUnlockToken) &&
            string.IsNullOrEmpty(request.TrustedDeviceApprovalToken))
            return E2EEpochVoidResult.Failure(E2EEpochErrorCode.Forbidden,
                "One of recoveryUnlockToken or trustedDeviceApprovalToken is required.");

        // Idempotency
        var bodyHash = ComputeBodyHash(
            $"{request.IdempotencyKey}:{request.ChallengeId}:{request.KeyBackup.EpochSetHashBase64Url}");
        var (alreadyDone, conflict) = await CheckIdempotencyAsync(
            request.IdempotencyKey, userUuid, "unlock-complete", bodyHash, ct);
        if (conflict is not null) return conflict;
        if (alreadyDone) return E2EEpochVoidResult.Ok;

        // Load existing epoch public identities for the recovered epochs
        var existingIdentities = await db.KeyEpochPublicIdentities
            .Where(e => e.UserUuid == userUuid && recoveredSet.Contains(e.KeyEpochId))
            .ToListAsync(ct);
        var existingIdentityMap = existingIdentities.ToDictionary(e => e.KeyEpochId);

        var identityKeyMap = request.EpochIdentityPublicKeys.ToDictionary(e => e.KeyEpochId, e => e.ValueBase64Url);
        var sigMap = request.EpochUnlockSignatures.ToDictionary(e => e.KeyEpochId, e => e.ValueBase64Url);

        var kb = request.KeyBackup;

        // Build canonical payload for verification (same string for all epochs)
        var canonicalPayload = BuildCanonicalUnlockPayload(
            userUuid,
            request.ResetRequestId,
            request.ChallengeId,
            kb.BackupKeyId,
            kb.BackupRevision,
            kb.EpochSetHashBase64Url,
            request.RecoveredKeyEpochIds);

        // Verify each epoch's Ed25519 signature
        foreach (var epochId in recoveredSet)
        {
            var identityPublicKeyBase64Url = identityKeyMap[epochId];
            var signatureBase64Url = sigMap[epochId];

            // If there's already a stored public key, it must match byte-for-byte
            if (existingIdentityMap.TryGetValue(epochId, out var storedIdentity))
            {
                if (!string.Equals(storedIdentity.EpochAccountIdentityPublicKeyBase64Url,
                        identityPublicKeyBase64Url, StringComparison.Ordinal))
                    return E2EEpochVoidResult.Failure(E2EEpochErrorCode.Conflict,
                        $"Epoch {epochId}: submitted epochAccountIdentityPublicKey conflicts with the stored key.");
            }

            if (!VerifyEd25519Signature(identityPublicKeyBase64Url, canonicalPayload, signatureBase64Url))
                return E2EEpochVoidResult.Failure(E2EEpochErrorCode.SignatureInvalid,
                    $"Ed25519 signature verification failed for epoch {epochId}.");
        }

        // Validate backup revision monotonicity & hash change
        var existingBackup = await db.UserE2EKeyBackups.FirstOrDefaultAsync(b => b.UserUuid == userUuid, ct);
        if (existingBackup is not null)
        {
            if (kb.BackupRevision <= existingBackup.BackupRevision)
                return E2EEpochVoidResult.Failure(E2EEpochErrorCode.Conflict,
                    "keyBackup.backupRevision must be greater than the current revision.");

            // epochSetHashBase64Url must change when recovering
            if (string.Equals(existingBackup.EpochSetHashBase64Url, kb.EpochSetHashBase64Url, StringComparison.Ordinal))
                return E2EEpochVoidResult.Failure(E2EEpochErrorCode.EpochSetHashUnchanged,
                    "epochSetHashBase64Url must differ from the previously stored hash in a successful unlock-complete.");
        }

        var now = DateTime.UtcNow;

        // Atomically: replace backup + upsert epoch identities + mark challenge used + transition state

        // Upsert backup
        if (existingBackup is null)
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
                CreatedAt = now,
                UpdatedAt = now,
            });
        }
        else
        {
            existingBackup.Version = kb.Version;
            existingBackup.BackupRevision = kb.BackupRevision;
            existingBackup.BackupKeyId = kb.BackupKeyId;
            existingBackup.PrimaryKeyEpochId = kb.PrimaryKeyEpochId;
            existingBackup.EpochSetRevision = kb.EpochSetRevision;
            existingBackup.EpochSetHashBase64Url = kb.EpochSetHashBase64Url;
            existingBackup.KdfName = kb.Kdf.Name;
            existingBackup.KdfMemoryKiB = kb.Kdf.MemoryKiB;
            existingBackup.KdfIterations = kb.Kdf.Iterations;
            existingBackup.KdfParallelism = kb.Kdf.Parallelism;
            existingBackup.KdfSaltBase64Url = kb.Kdf.SaltBase64Url;
            existingBackup.AeadName = kb.Aead.Name;
            existingBackup.AeadNonceBase64Url = kb.Aead.NonceBase64Url;
            existingBackup.CiphertextBase64Url = kb.CiphertextBase64Url;
            existingBackup.UpdatedAt = now;
        }

        // Upsert epoch public identities
        foreach (var epochId in recoveredSet)
        {
            if (existingIdentityMap.TryGetValue(epochId, out var stored))
            {
                stored.UpdatedAt = now;
            }
            else
            {
                db.KeyEpochPublicIdentities.Add(new KeyEpochPublicIdentity
                {
                    UserUuid = userUuid,
                    KeyEpochId = epochId,
                    EpochAccountIdentityPublicKeyBase64Url = identityKeyMap[epochId],
                    CreatedAt = now,
                    UpdatedAt = now,
                });
            }
        }

        // Register the new device as Active
        var newDeviceUuid = Guid.NewGuid();
        var primaryEpochId = kb.PrimaryKeyEpochId;
        db.UserDeviceKeys.Add(new UserDeviceKey
        {
            DeviceUuid = newDeviceUuid,
            UserUuid = userUuid,
            KeyEpochId = primaryEpochId,
            DisplayName = "",
            SigningPublicKeyBase64Url = request.NewDeviceSigningPublicKeyBase64Url,
            AgreementPublicKeyBase64Url = request.NewDeviceAgreementPublicKeyBase64Url,
            Status = DeviceKeyStatus.Active,
            CreatedAt = now,
        });

        // Mark challenge as used
        challenge.IsUsed = true;

        // Transition state: recovering → active
        state.State = E2EAccountStateKind.Active;
        state.UpdatedAt = now;

        await db.SaveChangesAsync(ct);

        // Record idempotency after commit
        await RecordIdempotencyAsync(request.IdempotencyKey, userUuid, "unlock-complete", bodyHash, ct);

        return E2EEpochVoidResult.Ok;
    }

    /// <inheritdoc/>
    public async Task<E2EEpochResult<AddPendingDeviceResponse>> AddPendingDeviceAsync(
        Guid userUuid, Guid keyEpochId, AddPendingDeviceRequest request, CancellationToken ct)
    {
        // Allowed when Active or ActiveNewEpoch
        var state = await db.UserE2EAccountStates.AsNoTracking()
            .FirstOrDefaultAsync(s => s.UserUuid == userUuid, ct);

        if (state is null ||
            (state.State != E2EAccountStateKind.Active && state.State != E2EAccountStateKind.ActiveNewEpoch))
            return E2EEpochResult<AddPendingDeviceResponse>.Failure(
                E2EEpochErrorCode.AccountNotInRequiredState,
                "Adding a pending device is only allowed when account state = active or active_new_epoch.");

        // Epoch must exist
        var epochExists = await db.KeyEpochPublicIdentities
            .AnyAsync(e => e.UserUuid == userUuid && e.KeyEpochId == keyEpochId, ct);
        if (!epochExists)
            return E2EEpochResult<AddPendingDeviceResponse>.Failure(
                E2EEpochErrorCode.NotFound,
                $"Key epoch {keyEpochId} not found for this user.");

        var now = DateTime.UtcNow;
        var deviceUuid = Guid.NewGuid();

        db.UserDeviceKeys.Add(new UserDeviceKey
        {
            DeviceUuid = deviceUuid,
            UserUuid = userUuid,
            KeyEpochId = keyEpochId,
            DisplayName = request.DisplayName ?? "",
            SigningPublicKeyBase64Url = request.SigningPublicKeyBase64Url,
            AgreementPublicKeyBase64Url = request.AgreementPublicKeyBase64Url,
            Status = DeviceKeyStatus.Pending,
            CreatedAt = now,
        });

        await db.SaveChangesAsync(ct);

        return E2EEpochResult<AddPendingDeviceResponse>.Success(new AddPendingDeviceResponse(deviceUuid));
    }

    /// <inheritdoc/>
    public async Task<E2EEpochResult<IReadOnlyList<DeviceKeyEntry>>> GetDevicesAsync(
        Guid userUuid, Guid keyEpochId, CancellationToken ct)
    {
        var devices = await db.UserDeviceKeys.AsNoTracking()
            .Where(d => d.UserUuid == userUuid && d.KeyEpochId == keyEpochId)
            .OrderBy(d => d.CreatedAt)
            .ToListAsync(ct);

        return E2EEpochResult<IReadOnlyList<DeviceKeyEntry>>.Success(
            devices.Select(MapDevice).ToList());
    }

    /// <inheritdoc/>
    public async Task<E2EEpochVoidResult> RevokeDeviceAsync(
        Guid userUuid, Guid keyEpochId, Guid deviceUuid, CancellationToken ct)
    {
        var device = await db.UserDeviceKeys
            .FirstOrDefaultAsync(d => d.DeviceUuid == deviceUuid && d.UserUuid == userUuid && d.KeyEpochId == keyEpochId, ct);

        if (device is null)
            return E2EEpochVoidResult.Failure(E2EEpochErrorCode.NotFound,
                $"Device {deviceUuid} not found for epoch {keyEpochId}.");

        if (device.Status == DeviceKeyStatus.Revoked) return E2EEpochVoidResult.Ok; // idempotent

        device.Status = DeviceKeyStatus.Revoked;
        device.RevokedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return E2EEpochVoidResult.Ok;
    }
}
