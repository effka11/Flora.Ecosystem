using Flora.Shared;

namespace Flora.Messaging.Domain;

public class UserMessageImageAsset
{
    public Guid ImageAssetUuid { get; set; } = FloraUuid.NewGuid();
    public Guid SenderUserUuid { get; set; }
    public Guid ReceiverUserUuid { get; set; }
    public Guid? MessageUuid { get; set; }
    public string ContentType { get; set; } = "application/octet-stream";
    public byte[] EncryptedBytes { get; set; } = [];
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
