namespace Flora.Notifications.Application;

public interface IClientPlatformService
{
    Task TouchAsync(Guid userUuid, string platform, CancellationToken ct = default);

    Task<IReadOnlyList<Guid>> ListUserUuidsAsync(string platform, CancellationToken ct = default);
}
