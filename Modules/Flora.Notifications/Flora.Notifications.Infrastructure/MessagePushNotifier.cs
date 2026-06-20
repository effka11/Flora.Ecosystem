using Flora.Messaging.Contracts;
using Flora.Notifications.Application;
using Flora.Notifications.Contracts;
using Flora.Shared;
using Microsoft.Extensions.Logging;

namespace Flora.Notifications.Infrastructure;

public sealed class MessagePushNotifier(
    IUserRealtimePublisher realtimePublisher,
    ILogger<MessagePushNotifier> log) : IMessageSentNotifier
{
    public async Task NotifyAsync(
        Guid recipientUserUuid,
        Guid senderUserUuid,
        MessageSentPushContext? pushContext = null,
        CancellationToken ct = default)
    {
        if (recipientUserUuid == Guid.Empty || senderUserUuid == Guid.Empty) return;
        if (recipientUserUuid == senderUserUuid) return;

        try
        {
            var conversationUuid = UuidV5.DmConversationUuid(senderUserUuid, recipientUserUuid);
            var signal = new RealtimeMessageSignal(conversationUuid, senderUserUuid, DateTime.UtcNow);
            var pushBody = MessagePushPreviewBuilder.Build(pushContext);
            await realtimePublisher.PublishMessageAsync(recipientUserUuid, signal, pushBody, ct);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Message push notify failed for recipient {Recipient}", recipientUserUuid);
        }
    }
}
