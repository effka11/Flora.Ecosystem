namespace Flora.Users.Domain;

public class UserProfile
{
    public Guid UserUuid { get; set; }
    public Guid? AvatarUuid { get; set; }
    public string DisplayName { get; set; } = "";
    public UserGender? Gender { get; set; }
    public DateOnly? BirthDate { get; set; }
    public string? Status { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public enum UserGender
{
    Male = 0,
    Female = 1
}
