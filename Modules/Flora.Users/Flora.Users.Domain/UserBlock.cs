namespace Flora.Users.Domain;

/// <summary>Владелец (<see cref="OwnerUserUuid"/>) заблокировал пользователя <see cref="BlockedUserUuid"/>.</summary>
public class UserBlock
{
    public Guid OwnerUserUuid { get; set; }
    public Guid BlockedUserUuid { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
