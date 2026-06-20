using Flora.Messaging.Contracts;

namespace Flora.Messaging.Application;

/// <summary>
/// Application service for conversation and message operations.
/// Handles cursor encoding/decoding, conversationUuid resolution,
/// and delegates data access to <see cref="IConversationRepository"/>.
/// </summary>
public interface IConversationService
{
    /// <summary>Returns cursor-paged conversation list for the current user.</summary>
    Task<ConversationsPage> GetConversationsAsync(
        Guid userUuid, string? cursor, int take, CancellationToken ct);

    /// <summary>
    /// Returns cursor-paged messages for the given conversation.
    /// Returns <c>null</c> if the conversation cannot be resolved.
    /// When <paramref name="otherUserUuid"/> is supplied it must match
    /// <see cref="UuidV5.DmConversationUuid"/> for the pair; empty threads are allowed.
    /// </summary>
    Task<MessagesPage?> GetMessagesAsync(
        Guid userUuid,
        Guid conversationUuid,
        Guid? otherUserUuid,
        string? cursor,
        int take,
        CancellationToken ct);

    /// <summary>
    /// Stores a pre-validated FSCP wire message when the receiver UUID is already known
    /// (extracted from the FSCP wire by the controller before calling this method).
    /// </summary>
    Task<SendMessageResult> SendMessageDirectAsync(
        Guid senderUuid,
        Guid receiverUuid,
        string encryptedForReceiver,
        string encryptedForSender,
        IReadOnlyList<Guid> voiceAssetUuids,
        IReadOnlyList<Guid> imageAssetUuids,
        IReadOnlyList<Guid> videoAssetUuids,
        MessageSentPushContext? pushContext = null,
        CancellationToken ct = default);

    /// <summary>
    /// Marks all unread messages in the conversation as read.
    /// Returns <c>false</c> if the conversation cannot be resolved.
    /// </summary>
    Task<bool> MarkReadAsync(
        Guid userUuid, Guid conversationUuid, Guid? otherUserUuid, CancellationToken ct);

    /// <summary>Число диалогов с хотя бы одним непрочитанным входящим сообщением (для tab bar / sidebar).</summary>
    Task<int> GetTotalUnreadCountAsync(Guid userUuid, CancellationToken ct);

    /// <summary>Deletes the sender's message in the given conversation.</summary>
    Task<DeleteMessageResult> DeleteMessageAsync(
        Guid userUuid,
        Guid conversationUuid,
        Guid messageUuid,
        CancellationToken ct);
}
