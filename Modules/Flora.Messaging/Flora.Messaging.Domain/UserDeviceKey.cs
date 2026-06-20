namespace Flora.Messaging.Domain;

public enum DeviceKeyStatus
{
    Pending,
    Active,
    Revoked,
}

/// <summary>
/// A device's public signing and agreement key pair for a specific key epoch.
/// Maps to table <c>user_device_keys</c>.
///
/// Canonical signature cover string (docs/fscp/e2e-security.md §UserDeviceKey):
///   flora.messaging.device-key.v1 | userUuid | keyEpochId | deviceUuid | signingPublicKey | agreementPublicKey | createdAt
/// </summary>
public sealed class UserDeviceKey
{
    public Guid DeviceUuid { get; set; }
    public Guid UserUuid { get; set; }
    public Guid KeyEpochId { get; set; }

    /// <summary>Optional display name, e.g. "Chrome on Windows" (≤ 100 chars).</summary>
    public string DisplayName { get; set; } = "";

    public string SigningPublicKeyBase64Url { get; set; } = "";
    public string AgreementPublicKeyBase64Url { get; set; } = "";

    /// <summary>
    /// Ed25519 signature of the canonical cover string above,
    /// produced by the epoch account identity private key.
    /// Null while the device key is still in Pending status.
    /// </summary>
    public string? SignedByEpochAccountIdentityBase64Url { get; set; }

    public DeviceKeyStatus Status { get; set; } = DeviceKeyStatus.Pending;

    public DateTime CreatedAt { get; set; }
    public DateTime? LastSeenAt { get; set; }
    public DateTime? RevokedAt { get; set; }
}
