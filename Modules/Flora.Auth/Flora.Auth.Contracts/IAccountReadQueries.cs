namespace Flora.Auth.Contracts;

public interface IAccountReadQueries
{
    Task<AccountRow?> FindActiveByPhoneAsync(string phone, CancellationToken cancellationToken = default);
    Task<AccountRow?> FindByUuidAsync(Guid userUuid, CancellationToken cancellationToken = default);
    Task<AccountRow?> FindByUsernameAsync(string username, CancellationToken cancellationToken = default);
    Task<bool> AnyPhoneAsync(string phone, CancellationToken cancellationToken = default);
    Task<bool> ExistsAsync(Guid userUuid, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<AccountRow>> GetByUuidsAsync(IReadOnlyCollection<Guid> userUuids, CancellationToken cancellationToken = default);
    Task<bool> UsernameTakenAsync(Guid excludeUserUuid, string username, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<AccountRow>> SearchAccountsAsync(Guid excludeUserUuid, string queryLower, int skip, int take, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<Guid>> ListActiveUserUuidsAsync(CancellationToken cancellationToken = default);
}
