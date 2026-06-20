namespace Flora.Messaging.Contracts;

// ── POST /api/messaging/e2e/epochs ───────────────────────────────────────────

/// <summary>Request body for POST /api/messaging/e2e/epochs (Create epoch).</summary>
public sealed record CreateEpochRequest(
    Guid AccountRecoverySessionId,
    Guid IdempotencyKey,
    Guid UxConfirmationId,
    Guid NewKeyEpochId,
    string NewEpochAccountIdentityPublicKeyBase64Url,
    string NewDeviceSigningPublicKeyBase64Url,
    string NewDeviceAgreementPublicKeyBase64Url,
    string? NewDeviceDisplayName,
    KeyBackupPayload KeyBackup);

// ── POST /api/messaging/e2e/unlock-complete/challenge ────────────────────────

/// <summary>Response from POST .../unlock-complete/challenge.</summary>
public sealed record UnlockChallengeResponse(
    Guid ChallengeId,
    Guid ResetRequestId,
    DateTime ExpiresAt,
    string CanonicalPayloadPreview);

// ── POST /api/messaging/e2e/unlock-complete ───────────────────────────────────

/// <summary>One entry in epochIdentityPublicKeys / epochUnlockSignatures arrays.</summary>
public sealed record EpochUnlockEntry(
    Guid KeyEpochId,
    string ValueBase64Url);

/// <summary>Request body for POST /api/messaging/e2e/unlock-complete.</summary>
public sealed record UnlockCompleteRequest(
    Guid ResetRequestId,
    Guid IdempotencyKey,
    Guid ChallengeId,
    IReadOnlyList<Guid> RecoveredKeyEpochIds,
    IReadOnlyList<EpochUnlockEntry> EpochIdentityPublicKeys,
    IReadOnlyList<EpochUnlockEntry> EpochUnlockSignatures,
    KeyBackupPayload KeyBackup,
    string NewDeviceSigningPublicKeyBase64Url,
    string NewDeviceAgreementPublicKeyBase64Url,
    string? RecoveryUnlockToken,
    string? TrustedDeviceApprovalToken);

// ── Device management ─────────────────────────────────────────────────────────

/// <summary>Request body for POST .../epochs/{keyEpochId}/devices/pending.</summary>
public sealed record AddPendingDeviceRequest(
    string SigningPublicKeyBase64Url,
    string AgreementPublicKeyBase64Url,
    string? DisplayName);

/// <summary>Response entry for GET .../epochs/{keyEpochId}/devices.</summary>
public sealed record DeviceKeyEntry(
    Guid DeviceUuid,
    Guid KeyEpochId,
    string DisplayName,
    string SigningPublicKeyBase64Url,
    string AgreementPublicKeyBase64Url,
    string Status,
    DateTime CreatedAt,
    DateTime? LastSeenAt,
    DateTime? RevokedAt);

/// <summary>Result for POST .../epochs/{keyEpochId}/devices/pending.</summary>
public sealed record AddPendingDeviceResponse(Guid DeviceUuid);
