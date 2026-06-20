using System.Text;
using Flora.Messaging.Contracts;
using Flora.Shared;

namespace Flora.Messaging.Application;

/// <inheritdoc cref="IConversationService"/>
public sealed class ConversationService(IConversationRepository repo, IMessageSentNotifier sentNotifier) : IConversationService
{
    // ── Cursor helpers ───────────────────────────────────────────────────────

    /// <summary>Encodes a keyset cursor as base64url(UTF8("{ticks}")).</summary>
    private static string EncodeCursor(DateTime at) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(at.ToUniversalTime().Ticks.ToString()))
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');

    private static DateTime? DecodeCursor(string? cursor)
    {
        if (string.IsNullOrEmpty(cursor)) return null;
        try
        {
            var padded = cursor.Replace('-', '+').Replace('_', '/');
            padded = padded.PadRight(padded.Length + (4 - padded.Length % 4) % 4, '=');
            var text = Encoding.UTF8.GetString(Convert.FromBase64String(padded));
            if (!long.TryParse(text, out var ticks)) return null;
            return new DateTime(ticks, DateTimeKind.Utc);
        }
        catch
        {
            return null;
        }
    }

    // ── conversationUuid resolution ──────────────────────────────────────────

    /// <summary>
    /// Finds the other participant's UUID given the deterministic conversationUuid.
    /// Returns null when the user has no conversation matching that UUID.
    /// </summary>
    private static Guid? ResolveOtherUser(Guid userUuid, IEnumerable<Guid> knownPartners, Guid conversationUuid)
    {
        foreach (var partner in knownPartners)
        {
            if (UuidV5.DmConversationUuid(userUuid, partner) == conversationUuid)
                return partner;
        }
        return null;
    }

    /// <summary>
    /// Resolves the peer for a DM: existing message history first, then explicit otherUserUuid.
    /// </summary>
    private static Guid? ResolveOtherUser(
        Guid userUuid,
        IEnumerable<Guid> knownPartners,
        Guid conversationUuid,
        Guid? otherUserUuid)
    {
        var fromHistory = ResolveOtherUser(userUuid, knownPartners, conversationUuid);
        if (fromHistory is not null)
            return fromHistory;

        if (otherUserUuid is null || otherUserUuid.Value == Guid.Empty || otherUserUuid.Value == userUuid)
            return null;

        return UuidV5.DmConversationUuid(userUuid, otherUserUuid.Value) == conversationUuid
            ? otherUserUuid.Value
            : null;
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /// <inheritdoc/>
    public async Task<ConversationsPage> GetConversationsAsync(
        Guid userUuid, string? cursor, int take, CancellationToken ct)
    {
        take = Math.Clamp(take, 1, 100);
        var cursorAt = DecodeCursor(cursor);

        var peers = await repo.GetPeerRowsAsync(userUuid, ct);

        // Apply cursor (skip conversations whose lastMessageAt >= cursorAt for older-first paging)
        IEnumerable<ConversationPeerRow> filtered = peers;
        if (cursorAt.HasValue)
            filtered = peers.Where(p => p.LastMessageAt < cursorAt.Value);

        var page = filtered.Take(take + 1).ToList();
        var hasMore = page.Count > take;
        if (hasMore) page.RemoveAt(page.Count - 1);

        var items = page.Select(p => new ConversationSummary(
            ConversationUuid: UuidV5.DmConversationUuid(userUuid, p.OtherUserUuid),
            OtherUserUuid: p.OtherUserUuid,
            LastMessageEncryptedForMe: p.LastEncryptedForMe,
            LastMessageContent: p.LastContent,
            LastMessageAt: p.LastMessageAt,
            LastMessageIsFromMe: p.LastIsFromMe,
            UnreadCount: p.UnreadCount
        )).ToList();

        var nextCursor = hasMore && page.Count > 0
            ? EncodeCursor(page[^1].LastMessageAt)
            : null;

        return new ConversationsPage(items, nextCursor, hasMore);
    }

    /// <inheritdoc/>
    public async Task<MessagesPage?> GetMessagesAsync(
        Guid userUuid,
        Guid conversationUuid,
        Guid? otherUserUuid,
        string? cursor,
        int take,
        CancellationToken ct)
    {
        take = Math.Clamp(take, 1, 100);
        var cursorAt = DecodeCursor(cursor);

        var peers = await repo.GetPeerRowsAsync(userUuid, ct);
        var otherUuid = ResolveOtherUser(
            userUuid, peers.Select(p => p.OtherUserUuid), conversationUuid, otherUserUuid);
        if (otherUuid is null) return null;

        var rows = await repo.GetMessagesPageAsync(userUuid, otherUuid.Value, cursorAt, take + 1, ct);

        var hasMore = rows.Count > take;
        var page = hasMore ? rows.Take(take).ToList() : rows.ToList();

        var items = page.Select(r => new MessageItem(
            MessageUuid: r.MessageUuid,
            SenderUserUuid: r.SenderUserUuid,
            EncryptedForMe: r.EncryptedForMe,
            Content: r.Content,
            CreatedAt: r.CreatedAt,
            IsRead: r.IsRead,
            IsFromMe: r.IsFromMe,
            VoiceAssetUuids: r.VoiceAssetUuids,
            ImageAssetUuids: r.ImageAssetUuids,
            VideoAssetUuids: r.VideoAssetUuids
        )).ToList();

        var nextCursor = hasMore && page.Count > 0
            ? EncodeCursor(page[^1].CreatedAt)
            : null;

        return new MessagesPage(items, nextCursor, hasMore);
    }

    /// <inheritdoc/>
    public async Task<SendMessageResult> SendMessageDirectAsync(
        Guid senderUuid,
        Guid receiverUuid,
        string encryptedForReceiver,
        string encryptedForSender,
        IReadOnlyList<Guid> voiceAssetUuids,
        IReadOnlyList<Guid> imageAssetUuids,
        IReadOnlyList<Guid> videoAssetUuids,
        MessageSentPushContext? pushContext = null,
        CancellationToken ct = default)
    {
        var result = await repo.SendMessageAsync(
            senderUuid, receiverUuid,
            encryptedForReceiver, encryptedForSender,
            voiceAssetUuids, imageAssetUuids, videoAssetUuids, ct);

        await sentNotifier.NotifyAsync(receiverUuid, senderUuid, pushContext, ct);
        return result;
    }

    /// <inheritdoc/>
    public Task<int> GetTotalUnreadCountAsync(Guid userUuid, CancellationToken ct) =>
        repo.GetTotalUnreadCountAsync(userUuid, ct);

    /// <inheritdoc/>
    public async Task<bool> MarkReadAsync(
        Guid userUuid, Guid conversationUuid, Guid? otherUserUuid, CancellationToken ct)
    {
        var peers = await repo.GetPeerRowsAsync(userUuid, ct);
        var otherUuid = ResolveOtherUser(
            userUuid, peers.Select(p => p.OtherUserUuid), conversationUuid, otherUserUuid);
        if (otherUuid is null) return false;

        await repo.MarkReadAsync(userUuid, otherUuid.Value, ct);
        return true;
    }

    /// <inheritdoc/>
    public Task<DeleteMessageResult> DeleteMessageAsync(
        Guid userUuid,
        Guid conversationUuid,
        Guid messageUuid,
        CancellationToken ct) =>
        repo.DeleteMessageAsync(userUuid, conversationUuid, messageUuid, ct);
}
