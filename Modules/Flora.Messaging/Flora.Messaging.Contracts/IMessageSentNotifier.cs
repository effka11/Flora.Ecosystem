namespace Flora.Messaging.Contracts;

/// <summary>
/// Cross-module port: notify recipient after a DM is persisted (e.g. FCM push).
/// Implemented outside Messaging; Messaging must not reference Notifications internals.
/// </summary>
public interface IMessageSentNotifier
{
    Task NotifyAsync(
        Guid recipientUserUuid,
        Guid senderUserUuid,
        MessageSentPushContext? pushContext = null,
        CancellationToken ct = default);
}
