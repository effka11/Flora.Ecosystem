namespace Flora.Messaging.Domain;

/// <summary>
/// Stores the public identity key for a specific key epoch of a user.
/// Used during unlock-complete validation to verify Ed25519 signatures
/// and during PUT key-backup to upsert public keys.
/// Maps to table <c>key_epoch_public_identities</c>.
/// </summary>
public sealed class KeyEpochPublicIdentity
{
    public Guid UserUuid { get; set; }
    public Guid KeyEpochId { get; set; }

    /// <summary>Base64url-encoded Ed25519 public key (32 bytes). Server uses this for signature verification.</summary>
    public string EpochAccountIdentityPublicKeyBase64Url { get; set; } = "";

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}
