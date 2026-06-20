namespace Flora.Messaging.Domain;

public class UserE2EKey
{
    public Guid UserUuid { get; set; }
    public string PublicKeyBase64 { get; set; } = "";
    /// <summary>Идентификатор устройства для FSCP v1 (recipient.deviceUuid); до миграции может быть null — клиенты используют bootstrap sentinel.</summary>
    public Guid? DeviceUuid { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
