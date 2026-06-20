using Flora.Notifications.Contracts;

namespace Flora.Notifications.Application;

/// <summary>Publishes realtime signals to SSE hub and FCM (mobile).</summary>
public interface IUserRealtimePublisher
{
    Task PublishMessageAsync(
        Guid recipientUserUuid,
        RealtimeMessageSignal signal,
        string? pushBody = null,
        CancellationToken ct = default);

    Task PublishNotificationAsync(Guid recipientUserUuid, RealtimeNotificationSignal signal, CancellationToken ct = default);
}
