using Flora.Notifications.Contracts;

namespace Flora.Notifications.Application;

/// <summary>SSE fan-out for authenticated dashboard clients (v1: in-process).</summary>
public interface IUserRealtimeHub
{
    (Guid ConnectionId, IAsyncEnumerable<string> Frames) Subscribe(Guid userUuid, CancellationToken ct);

    void Unsubscribe(Guid userUuid, Guid connectionId);

    Task PublishMessageAsync(Guid userUuid, RealtimeMessageSignal signal, CancellationToken ct = default);

    Task PublishNotificationAsync(Guid userUuid, RealtimeNotificationSignal signal, CancellationToken ct = default);
}
