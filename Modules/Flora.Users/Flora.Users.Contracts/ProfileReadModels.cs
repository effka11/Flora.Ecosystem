namespace Flora.Users.Contracts;

public sealed record UserProfileRow(
    Guid UserUuid,
    string DisplayName,
    Guid? AvatarUuid,
    int? Gender,
    DateOnly? BirthDate,
    string? Status);
