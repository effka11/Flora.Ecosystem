namespace Flora.Users.Contracts;

public interface IUserProfileReadQueries
{
    Task<UserProfileRow?> FindByUserUuidAsync(Guid userUuid, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<UserProfileRow>> GetByUserUuidsAsync(IReadOnlyCollection<Guid> userUuids, CancellationToken cancellationToken = default);
}
