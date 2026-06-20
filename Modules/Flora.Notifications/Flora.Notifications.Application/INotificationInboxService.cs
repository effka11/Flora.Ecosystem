using Flora.Notifications.Contracts;

namespace Flora.Notifications.Application;

public interface INotificationInboxService
{
    Task DispatchAsync(CreateUserNotificationCommand command, CancellationToken ct = default);

    Task<IReadOnlyList<NotificationDto>> ListAsync(
        Guid recipientUserUuid,
        string? category,
        string? search,
        int skip,
        int take,
        CancellationToken ct = default);

    Task<int> GetUnreadCountAsync(Guid recipientUserUuid, CancellationToken ct = default);

    Task<bool> MarkReadAsync(Guid recipientUserUuid, Guid notificationUuid, CancellationToken ct = default);

    Task<int> MarkAllReadAsync(Guid recipientUserUuid, CancellationToken ct = default);

    Task<int> DeleteAsync(DeleteNotificationsCommand command, CancellationToken ct = default);

    Task<int> DeleteAllAsync(Guid recipientUserUuid, CancellationToken ct = default);
}
