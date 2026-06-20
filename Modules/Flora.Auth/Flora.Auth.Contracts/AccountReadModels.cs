namespace Flora.Auth.Contracts;

public sealed record AccountRow(
    Guid UserUuid,
    string Username,
    string Phone,
    string? Email,
    int Status,
    DateTime CreatedAt,
    DateTime UpdatedAt);
