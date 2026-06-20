namespace Flora.Messaging.Contracts;

// ── Shared KDF / AEAD sub-objects ────────────────────────────────────────────

public sealed record KdfParams(
    string Name,
    int MemoryKiB,
    int Iterations,
    int Parallelism,
    string SaltBase64Url);

public sealed record AeadParams(
    string Name,
    string NonceBase64Url);

// ── UserE2EKeyBackup ──────────────────────────────────────────────────────────

/// <summary>Full password-encrypted key backup payload (PUT and GET).</summary>
public sealed record KeyBackupPayload(
    int Version,
    int BackupRevision,
    Guid BackupKeyId,
    Guid UserUuid,
    Guid PrimaryKeyEpochId,
    int EpochSetRevision,
    string EpochSetHashBase64Url,
    KdfParams Kdf,
    AeadParams Aead,
    string CiphertextBase64Url);

/// <summary>Epoch public identity entry attached to PUT key-backup.</summary>
public sealed record EpochIdentityPublicKeyEntry(
    Guid KeyEpochId,
    string EpochAccountIdentityPublicKeyBase64Url);

/// <summary>Request body for PUT /api/messaging/e2e/key-backup.</summary>
public sealed record PutKeyBackupRequest(
    KeyBackupPayload KeyBackup,
    IReadOnlyList<EpochIdentityPublicKeyEntry>? EpochIdentityPublicKeys = null);

// ── UserE2ERecoveryBackup ─────────────────────────────────────────────────────

/// <summary>Wordlist metadata embedded in recovery backup.</summary>
public sealed record WordlistInfo(string Id, int WordsCount);

/// <summary>Full recovery backup payload (PUT and GET with ciphertext).</summary>
public sealed record RecoveryBackupPayload(
    int Version,
    int RecoveryRevision,
    Guid RecoveryKeyId,
    Guid UserUuid,
    Guid PrimaryKeyEpochId,
    int EpochSetRevision,
    string EpochSetHashBase64Url,
    WordlistInfo Wordlist,
    KdfParams Kdf,
    AeadParams Aead,
    string CiphertextBase64Url);

/// <summary>Recovery backup metadata only (GET list — no ciphertext).</summary>
public sealed record RecoveryBackupMeta(
    Guid RecoveryKeyId,
    int RecoveryRevision,
    Guid PrimaryKeyEpochId,
    int EpochSetRevision,
    string EpochSetHashBase64Url,
    WordlistInfo Wordlist,
    DateTime CreatedAt,
    DateTime UpdatedAt,
    DateTime? UsedAt);

// ── E2E Account State ─────────────────────────────────────────────────────────

/// <summary>Response for GET /api/messaging/e2e/state.</summary>
public sealed record E2EStateResponse(
    string State,
    bool Freeze,
    DateTime UpdatedAt);
