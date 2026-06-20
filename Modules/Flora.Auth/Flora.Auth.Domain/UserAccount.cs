using Flora.Shared;

namespace Flora.Auth.Domain;

public class UserAccount
{
    public Guid UserUuid { get; set; } = FloraUuid.NewGuid();
    public string Username { get; set; } = "";
    public string Phone { get; set; } = "";
    public bool PhoneVerified { get; set; }
    public string PasswordHash { get; set; } = "";
    public string? Email { get; set; }
    public bool EmailVerified { get; set; }
    public bool TwoFactorEnabled { get; set; }
    /// <summary>Base32-encoded TOTP secret; null when 2FA is disabled.</summary>
    public string? TwoFactorSecret { get; set; }
    public UserAccountStatus Status { get; set; }
    public DateTime? LastLogin { get; set; } = DateTime.UtcNow;
    public ulong ServicesMask { get; set; }
    public bool PrivacyAccepted { get; set; }
    public bool TosAccepted { get; set; }
    public bool HasSocialNetwork { get; set; }
    public bool HasEmail { get; set; }
    public byte ServicesCount { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public virtual UserSecurityLogs? SecurityLogs { get; set; }
    public virtual ICollection<UserSession> Sessions { get; set; } = new List<UserSession>();

    public static UserAccount CreateForPhoneRegistration(Guid userUuid, string phone, string username, string passwordHash) =>
        new()
        {
            UserUuid = userUuid,
            Phone = phone,
            Username = username,
            PasswordHash = passwordHash,
            Status = UserAccountStatus.Active,
            ServicesMask = 1UL,
            HasSocialNetwork = true,
            ServicesCount = 1
        };
}

public enum UserAccountStatus
{
    Active = 0,
    Inactive = 1,
    Suspended = 2,
    Deleted = 3,
    Banned = 4
}
