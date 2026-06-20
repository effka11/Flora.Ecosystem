namespace Flora.Messaging.Domain;

/// <summary>
/// Server-side store for the user's password-encrypted E2E key backup.
/// The server stores opaque ciphertext only and cannot decrypt it.
/// Corresponds to <c>UserE2EKeyBackup</c> payload in docs/fscp/e2e-security.md.
/// Maps to table <c>user_e2e_key_backups</c>.
/// </summary>
public sealed class UserE2EKeyBackup
{
    public Guid UserUuid { get; set; }

    // --- Versioning ---
    public int Version { get; set; }
    public int BackupRevision { get; set; }
    public Guid BackupKeyId { get; set; }
    public Guid PrimaryKeyEpochId { get; set; }
    public int EpochSetRevision { get; set; }
    public string EpochSetHashBase64Url { get; set; } = "";

    // --- KDF (Argon2id) parameters —-- stored by client, never used server-side ---
    public string KdfName { get; set; } = "argon2id";
    public int KdfMemoryKiB { get; set; }
    public int KdfIterations { get; set; }
    public int KdfParallelism { get; set; }
    public string KdfSaltBase64Url { get; set; } = "";

    // --- AEAD (XChaCha20-Poly1305) ---
    public string AeadName { get; set; } = "xchacha20-poly1305";
    public string AeadNonceBase64Url { get; set; } = "";

    // --- Opaque ciphertext (server cannot decrypt) ---
    public string CiphertextBase64Url { get; set; } = "";

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}
