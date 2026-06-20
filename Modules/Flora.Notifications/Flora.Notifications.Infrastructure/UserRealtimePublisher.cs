using Flora.Notifications.Application;
using Flora.Notifications.Contracts;
using Microsoft.Extensions.Logging;

namespace Flora.Notifications.Infrastructure;

public sealed class UserRealtimePublisher(
    IUserRealtimeHub hub,
    IPushTokenService pushTokens,
    IMessagePushDispatcher pushDispatcher,
    IUserDisplayNameResolver displayNames,
    ILogger<UserRealtimePublisher> log) : IUserRealtimePublisher
{
    public async Task PublishMessageAsync(
        Guid recipientUserUuid,
        RealtimeMessageSignal signal,
        string? pushBody = null,
        CancellationToken ct = default)
    {
        if (recipientUserUuid == Guid.Empty) return;

        try
        {
            await hub.PublishMessageAsync(recipientUserUuid, signal, ct);

            var tokens = await pushTokens.GetTokensForUserAsync(recipientUserUuid, ct);
            if (tokens.Count == 0) return;

            var displayName = await displayNames.ResolveDisplayNameAsync(signal.SenderUserUuid, ct);
            var body = string.IsNullOrWhiteSpace(pushBody) ? "Новое сообщение" : pushBody.Trim();
            await pushDispatcher.SendMessagePushAsync(
                recipientUserUuid,
                tokens,
                displayName,
                body,
                signal.ConversationUuid,
                signal.SenderUserUuid,
                ct);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Realtime message publish failed for recipient {Recipient}", recipientUserUuid);
        }
    }

    public async Task PublishNotificationAsync(
        Guid recipientUserUuid,
        RealtimeNotificationSignal signal,
        CancellationToken ct = default)
    {
        if (recipientUserUuid == Guid.Empty) return;

        try
        {
            await hub.PublishNotificationAsync(recipientUserUuid, signal, ct);

            var tokens = await pushTokens.GetTokensForUserAsync(recipientUserUuid, ct);
            if (tokens.Count == 0) return;

            string? actorName = null;
            if (signal.ActorUserUuid is Guid actor && actor != Guid.Empty)
                actorName = await displayNames.ResolveDisplayNameAsync(actor, ct);

            await pushDispatcher.SendInboxNotificationPushAsync(
                recipientUserUuid,
                tokens,
                signal.NotificationUuid,
                signal.Type,
                signal.Category,
                signal.Text,
                actorName,
                signal.PostUuid,
                signal.CommentUuid,
                ct);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Realtime notification publish failed for recipient {Recipient}", recipientUserUuid);
        }
    }
}
