using Flora.Notifications.Contracts;

namespace Flora.Notifications.Application;

public interface INotificationInboxService
{
    Task DispatchAsync(CreateUserNotificationCommand command, CancellationToken ct = default);

    Task<int> BroadcastAsync(CreateBroadcastNotificationCommand command, CancellationToken ct = default);

    Task<IReadOnlyList<NotificationDto>> ListAsync(
        Guid recipientUserUuid,
        string? category,
        string? search,
        int skip,
        int take,
        string? clientPlatform = null,
        CancellationToken ct = default);

    Task<int> GetUnreadCountAsync(Guid recipientUserUuid, string? clientPlatform = null, CancellationToken ct = default);

    Task<bool> MarkReadAsync(Guid recipientUserUuid, Guid notificationUuid, CancellationToken ct = default);

    Task<int> MarkAllReadAsync(Guid recipientUserUuid, string? clientPlatform = null, CancellationToken ct = default);

    Task<int> DeleteAsync(DeleteNotificationsCommand command, CancellationToken ct = default);

    Task<int> DeleteAllAsync(Guid recipientUserUuid, string? clientPlatform = null, CancellationToken ct = default);
}
