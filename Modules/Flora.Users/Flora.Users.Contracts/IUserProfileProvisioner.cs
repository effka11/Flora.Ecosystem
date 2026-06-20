namespace Flora.Users.Contracts;

public interface IUserProfileProvisioner
{
    Task EnsureInitialProfileAsync(Guid userUuid, string displayName, CancellationToken cancellationToken = default);
}
