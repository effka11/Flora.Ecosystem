using Flora.Shared;

namespace Flora.Auth.Domain;

public class UserSession
{
    public Guid SessionId { get; set; } = FloraUuid.NewGuid();
    public Guid UserUuid { get; set; }
    public string AgentHash { get; set; } = "";
    public string IpAddress { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresAt { get; set; }
    public DateTime LastActivity { get; set; } = DateTime.UtcNow;
    public string JwtId { get; set; } = "";
    public string RefreshToken { get; set; } = "";
    public uint RotationId { get; set; }
    public UserSessionStatus Status { get; set; }
    public string? CountryCode { get; set; }
    public string? Region { get; set; }
    public string? City { get; set; }
    public string CsrfToken { get; set; } = "";
    public string HmacKey { get; set; } = "";
}

public enum UserSessionStatus
{
    Active = 0,
    Expired = 1,
    RevokedPassword = 2,
    RevokedAdmin = 3,
    RevokedUser = 4,
    Suspicious = 5
}
