using Flora.Messaging.Contracts;

namespace Flora.Messaging.Application;

/// <summary>
/// Data access abstraction for the conversations feature.
/// Infrastructure implements this; Application depends on it.
/// </summary>
public interface IConversationRepository
{
    /// <summary>
    /// Returns one row per distinct conversation partner of <paramref name="userUuid"/>,
    /// carrying the most recent message metadata and unread count.
    /// Ordered by last-message timestamp descending.
    /// </summary>
    Task<IReadOnlyList<ConversationPeerRow>> GetPeerRowsAsync(Guid userUuid, CancellationToken ct);

    /// <summary>
    /// Keyset-paginated messages between <paramref name="userUuid"/> and
    /// <paramref name="otherUserUuid"/>, newest first.
    /// </summary>
    /// <param name="cursorAt">Exclusive upper bound on created_at (last seen).</param>
    /// <param name="take">Page size + 1 so the caller can detect HasMore.</param>
    Task<IReadOnlyList<MessageRow>> GetMessagesPageAsync(
        Guid userUuid,
        Guid otherUserUuid,
        DateTime? cursorAt,
        int take,
        CancellationToken ct);

    /// <summary>Stores a validated FSCP wire message and links any voice/image/video assets.</summary>
    Task<SendMessageResult> SendMessageAsync(
        Guid senderUuid,
        Guid receiverUuid,
        string encryptedForReceiver,
        string encryptedForSender,
        IReadOnlyList<Guid> voiceAssetUuids,
        IReadOnlyList<Guid> imageAssetUuids,
        IReadOnlyList<Guid> videoAssetUuids,
        CancellationToken ct);

    /// <summary>Marks all unread messages from <paramref name="otherUserUuid"/> as read.</summary>
    Task MarkReadAsync(Guid viewerUuid, Guid otherUserUuid, CancellationToken ct);

    /// <summary>Число диалогов с хотя бы одним непрочитанным входящим сообщением.</summary>
    Task<int> GetTotalUnreadCountAsync(Guid userUuid, CancellationToken ct);

    /// <summary>Hard-deletes a message when the viewer is the sender and the conversation matches.</summary>
    Task<DeleteMessageResult> DeleteMessageAsync(
        Guid viewerUuid,
        Guid conversationUuid,
        Guid messageUuid,
        CancellationToken ct);
}
