using Flora.Shared;

namespace Flora.Messaging.Domain;

public class UserMessage
{
    public Guid MessageUuid { get; set; } = FloraUuid.NewGuid();
    public Guid SenderUserUuid { get; set; }
    public Guid ReceiverUserUuid { get; set; }
    public string? Content { get; set; }
    public string? EncryptedForReceiver { get; set; }
    public string? EncryptedForSender { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public bool IsRead { get; set; }
}
