namespace Flora.Users.Contracts;

public sealed record UserBlocklistEntryDto(
    Guid UserUuid,
    string Username,
    string DisplayName,
    DateTime BlockedAtUtc);

public sealed record UserBlockRecord(Guid BlockedUserUuid, DateTime BlockedAtUtc);

public interface IUserBlocklistService
{
    Task<bool> IsBlockedByAsync(Guid ownerUserUuid, Guid viewerUserUuid, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<UserBlockRecord>> ListAsync(Guid ownerUserUuid, CancellationToken cancellationToken = default);

    Task BlockAsync(Guid ownerUserUuid, Guid blockedUserUuid, CancellationToken cancellationToken = default);

    Task UnblockAsync(Guid ownerUserUuid, Guid blockedUserUuid, CancellationToken cancellationToken = default);
}
