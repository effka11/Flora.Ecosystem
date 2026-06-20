using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading.Channels;
using Flora.Notifications.Application;
using Flora.Notifications.Contracts;

namespace Flora.Notifications.Infrastructure;

public sealed class UserRealtimeHub : IUserRealtimeHub
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly ConcurrentDictionary<Guid, ConcurrentDictionary<Guid, Channel<string>>> _connections = new();

    public (Guid ConnectionId, IAsyncEnumerable<string> Frames) Subscribe(Guid userUuid, CancellationToken ct)
    {
        var connectionId = Guid.NewGuid();
        var channel = Channel.CreateUnbounded<string>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false,
        });

        var userConnections = _connections.GetOrAdd(userUuid, _ => new ConcurrentDictionary<Guid, Channel<string>>());
        userConnections[connectionId] = channel;

        ct.Register(() =>
        {
            Unsubscribe(userUuid, connectionId);
            channel.Writer.TryComplete();
        });

        return (connectionId, ReadFramesAsync(channel.Reader, ct));
    }

    public void Unsubscribe(Guid userUuid, Guid connectionId)
    {
        if (!_connections.TryGetValue(userUuid, out var userConnections)) return;
        if (!userConnections.TryRemove(connectionId, out var channel)) return;
        channel.Writer.TryComplete();
        if (userConnections.IsEmpty)
            _connections.TryRemove(userUuid, out _);
    }

    public Task PublishMessageAsync(Guid userUuid, RealtimeMessageSignal signal, CancellationToken ct = default) =>
        BroadcastAsync(userUuid, "message", signal, ct);

    public Task PublishNotificationAsync(Guid userUuid, RealtimeNotificationSignal signal, CancellationToken ct = default) =>
        BroadcastAsync(userUuid, "notification", signal, ct);

    private Task BroadcastAsync<T>(Guid userUuid, string eventName, T payload, CancellationToken ct)
    {
        if (!_connections.TryGetValue(userUuid, out var userConnections) || userConnections.IsEmpty)
            return Task.CompletedTask;

        var json = JsonSerializer.Serialize(payload, JsonOptions);
        var frame = $"event: {eventName}\ndata: {json}\n\n";

        foreach (var (_, channel) in userConnections)
            channel.Writer.TryWrite(frame);

        return Task.CompletedTask;
    }

    private static async IAsyncEnumerable<string> ReadFramesAsync(
        ChannelReader<string> reader,
        [EnumeratorCancellation] CancellationToken ct)
    {
        while (await reader.WaitToReadAsync(ct).ConfigureAwait(false))
        {
            while (reader.TryRead(out var frame))
                yield return frame;
        }
    }
}
