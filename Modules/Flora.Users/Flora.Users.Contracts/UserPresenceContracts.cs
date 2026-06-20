namespace Flora.Users.Contracts;

public interface IUserPresenceService
{
    Task TouchAsync(Guid userUuid, CancellationToken cancellationToken = default);

    Task<IReadOnlyDictionary<Guid, DateTime?>> GetLastSeenUtcByUserUuidsAsync(
        IReadOnlyCollection<Guid> userUuids,
        CancellationToken cancellationToken = default);
}
