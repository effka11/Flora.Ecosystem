namespace Flora.Messaging.Domain;

/// <summary>
/// Server-side store for the user's recovery-phrase-encrypted E2E backup.
/// Structurally identical to <see cref="UserE2EKeyBackup"/> but uses a
/// separate KDF salt and stricter parameters (iterations: 4 vs 3).
/// Maps to table <c>user_e2e_recovery_backups</c>.
/// </summary>
public sealed class UserE2ERecoveryBackup
{
    /// <summary>Deterministic UUID chosen by the client. Acts as the stable identifier for this recovery backup.</summary>
    public Guid RecoveryKeyId { get; set; }

    public Guid UserUuid { get; set; }

    // --- Versioning ---
    public int Version { get; set; }
    public int RecoveryRevision { get; set; }
    public Guid PrimaryKeyEpochId { get; set; }
    public int EpochSetRevision { get; set; }
    public string EpochSetHashBase64Url { get; set; } = "";

    // --- Wordlist metadata (persisted, not used server-side) ---
    public string WordlistId { get; set; } = "";
    public int WordsCount { get; set; }

    // --- KDF (Argon2id) parameters ---
    public string KdfName { get; set; } = "argon2id";
    public int KdfMemoryKiB { get; set; }
    public int KdfIterations { get; set; }
    public int KdfParallelism { get; set; }
    public string KdfSaltBase64Url { get; set; } = "";

    // --- AEAD (XChaCha20-Poly1305) ---
    public string AeadName { get; set; } = "xchacha20-poly1305";
    public string AeadNonceBase64Url { get; set; } = "";

    // --- Opaque ciphertext ---
    public string CiphertextBase64Url { get; set; } = "";

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }

    /// <summary>Set when this recovery backup is consumed during the unlock-complete flow.</summary>
    public DateTime? UsedAt { get; set; }
}
