namespace Flora.Users.Domain;

public class UserAvatar
{
    public Guid Uuid { get; set; }
    public Guid UserUuid { get; set; }
    public string ContentType { get; set; } = "image/jpeg";
    public byte[] Data { get; set; } = Array.Empty<byte>();
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
