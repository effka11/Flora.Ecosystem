namespace Flora.Notifications.Application;

public interface IPushTokenService
{
    Task RegisterAsync(Guid userUuid, string token, string platform, CancellationToken ct = default);
    Task UnregisterAsync(Guid userUuid, string token, CancellationToken ct = default);
    Task<IReadOnlyList<string>> GetTokensForUserAsync(Guid userUuid, CancellationToken ct = default);

    Task<IReadOnlyList<Guid>> ListUserUuidsByPlatformAsync(string platform, CancellationToken ct = default);
}

public interface IMessagePushDispatcher
{
    Task SendMessagePushAsync(
        Guid recipientUserUuid,
        IReadOnlyList<string> deviceTokens,
        string senderDisplayName,
        string body,
        Guid conversationUuid,
        Guid senderUserUuid,
        CancellationToken ct = default);

    Task SendInboxNotificationPushAsync(
        Guid recipientUserUuid,
        IReadOnlyList<string> deviceTokens,
        Guid notificationUuid,
        string inboxType,
        string category,
        string text,
        string? actorDisplayName,
        Guid? postUuid,
        Guid? commentUuid,
        CancellationToken ct = default);
}

/// <summary>Resolved at product composition (Auth/Users bridge).</summary>
public interface IUserDisplayNameResolver
{
    Task<string> ResolveDisplayNameAsync(Guid userUuid, CancellationToken ct = default);
}
