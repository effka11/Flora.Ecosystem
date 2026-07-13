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

    /// <summary>
    /// Пользователи, с которыми у <paramref name="userUuid"/> есть блокировка в любом направлении.
    /// FIRA §12 (инвариант 2): блокировка исключает из кандидатных пулов рекомендаций, а не понижает.
    /// </summary>
    Task<IReadOnlySet<Guid>> GetBlockedUserIdsBidirectionalAsync(Guid userUuid, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<UserBlockRecord>> ListAsync(Guid ownerUserUuid, CancellationToken cancellationToken = default);

    Task BlockAsync(Guid ownerUserUuid, Guid blockedUserUuid, CancellationToken cancellationToken = default);

    Task UnblockAsync(Guid ownerUserUuid, Guid blockedUserUuid, CancellationToken cancellationToken = default);
}
