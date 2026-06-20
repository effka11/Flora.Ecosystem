using Flora.Messaging.Application;
using Flora.Messaging.Contracts;
using Flora.Messaging.Domain;
using Flora.Shared;
using Microsoft.EntityFrameworkCore;

namespace Flora.Messaging.Infrastructure;

/// <inheritdoc cref="IConversationRepository"/>
public sealed class ConversationRepository(MessagingDbContext db) : IConversationRepository
{
    /// <inheritdoc/>
    public async Task<IReadOnlyList<ConversationPeerRow>> GetPeerRowsAsync(Guid userUuid, CancellationToken ct)
    {
        // Load all messages involving the user in a single query.
        // For large message stores this should be replaced with a GROUP BY query;
        // for the bridge phase this mirrors the existing ImportedSocialController approach.
        var messages = await db.UserMessages.AsNoTracking()
            .Where(m => m.SenderUserUuid == userUuid || m.ReceiverUserUuid == userUuid)
            .OrderByDescending(m => m.CreatedAt)
            .ToListAsync(ct);

        var lastByOther = new Dictionary<Guid, (Guid MessageUuid, string? Content, string? EncReceiver, string? EncSender, DateTime At, bool FromMe)>();
        var unreadByOther = new Dictionary<Guid, int>();

        foreach (var m in messages)
        {
            var other = m.SenderUserUuid == userUuid ? m.ReceiverUserUuid : m.SenderUserUuid;
            var isFromMe = m.SenderUserUuid == userUuid;

            if (!lastByOther.ContainsKey(other))
                lastByOther[other] = (m.MessageUuid, m.Content, m.EncryptedForReceiver, m.EncryptedForSender, m.CreatedAt, isFromMe);

            if (!isFromMe && !m.IsRead)
                unreadByOther[other] = unreadByOther.GetValueOrDefault(other, 0) + 1;
        }

        return lastByOther
            .Select(kv =>
            {
                var (msgUuid, content, encRcv, encSnd, at, fromMe) = kv.Value;
                // encryptedForMe: if I'm the receiver pick encryptedForReceiver, otherwise encryptedForSender.
                var encForMe = fromMe ? encSnd : encRcv;
                return new ConversationPeerRow(
                    OtherUserUuid: kv.Key,
                    LastMessageUuid: msgUuid,
                    LastEncryptedForMe: encForMe,
                    LastContent: content is { Length: > 0 } ? content : null,
                    LastMessageAt: at,
                    LastIsFromMe: fromMe,
                    UnreadCount: unreadByOther.GetValueOrDefault(kv.Key, 0));
            })
            .OrderByDescending(r => r.LastMessageAt)
            .ToList();
    }

    /// <inheritdoc/>
    public async Task<IReadOnlyList<MessageRow>> GetMessagesPageAsync(
        Guid userUuid,
        Guid otherUserUuid,
        DateTime? cursorAt,
        int take,
        CancellationToken ct)
    {
        var query = db.UserMessages.AsNoTracking()
            .Where(m => (m.SenderUserUuid == userUuid && m.ReceiverUserUuid == otherUserUuid) ||
                        (m.SenderUserUuid == otherUserUuid && m.ReceiverUserUuid == userUuid));

        if (cursorAt.HasValue)
            query = query.Where(m => m.CreatedAt < cursorAt.Value);

        var messages = await query
            .OrderByDescending(m => m.CreatedAt)
            .Take(take)
            .Select(m => new
            {
                m.MessageUuid,
                m.SenderUserUuid,
                m.EncryptedForReceiver,
                m.EncryptedForSender,
                m.Content,
                m.CreatedAt,
                m.IsRead,
            })
            .ToListAsync(ct);

        if (messages.Count == 0)
            return [];

        // Fetch linked voice assets in one batch query.
        var msgIds = messages.Select(m => m.MessageUuid).ToList();
        var voiceAssets = await db.UserMessageVoiceAssets.AsNoTracking()
            .Where(a => a.MessageUuid.HasValue && msgIds.Contains(a.MessageUuid.Value))
            .Select(a => new { a.VoiceAssetUuid, a.MessageUuid })
            .ToListAsync(ct);

        var imageAssets = await db.UserMessageImageAssets.AsNoTracking()
            .Where(a => a.MessageUuid.HasValue && msgIds.Contains(a.MessageUuid.Value))
            .Select(a => new { a.ImageAssetUuid, a.MessageUuid })
            .ToListAsync(ct);

        var videoAssets = await db.UserMessageVideoAssets.AsNoTracking()
            .Where(a => a.MessageUuid.HasValue && msgIds.Contains(a.MessageUuid.Value))
            .Select(a => new { a.VideoAssetUuid, a.MessageUuid })
            .ToListAsync(ct);

        var voiceByMsg = voiceAssets
            .GroupBy(a => a.MessageUuid!.Value)
            .ToDictionary(g => g.Key, g => (IReadOnlyList<Guid>)g.Select(a => a.VoiceAssetUuid).ToList());

        var imageByMsg = imageAssets
            .GroupBy(a => a.MessageUuid!.Value)
            .ToDictionary(g => g.Key, g => (IReadOnlyList<Guid>)g.Select(a => a.ImageAssetUuid).ToList());

        var videoByMsg = videoAssets
            .GroupBy(a => a.MessageUuid!.Value)
            .ToDictionary(g => g.Key, g => (IReadOnlyList<Guid>)g.Select(a => a.VideoAssetUuid).ToList());

        return messages.Select(m => new MessageRow(
            MessageUuid: m.MessageUuid,
            SenderUserUuid: m.SenderUserUuid,
            EncryptedForMe: m.SenderUserUuid == userUuid ? m.EncryptedForSender : m.EncryptedForReceiver,
            Content: m.Content,
            CreatedAt: m.CreatedAt,
            IsRead: m.IsRead,
            IsFromMe: m.SenderUserUuid == userUuid,
            VoiceAssetUuids: voiceByMsg.GetValueOrDefault(m.MessageUuid, []),
            ImageAssetUuids: imageByMsg.GetValueOrDefault(m.MessageUuid, []),
            VideoAssetUuids: videoByMsg.GetValueOrDefault(m.MessageUuid, [])
        )).ToList();
    }

    /// <inheritdoc/>
    public async Task<SendMessageResult> SendMessageAsync(
        Guid senderUuid,
        Guid receiverUuid,
        string encryptedForReceiver,
        string encryptedForSender,
        IReadOnlyList<Guid> voiceAssetUuids,
        IReadOnlyList<Guid> imageAssetUuids,
        IReadOnlyList<Guid> videoAssetUuids,
        CancellationToken ct)
    {
        var msg = new UserMessage
        {
            MessageUuid = FloraUuid.NewGuid(),
            SenderUserUuid = senderUuid,
            ReceiverUserUuid = receiverUuid,
            Content = null,
            EncryptedForReceiver = encryptedForReceiver,
            EncryptedForSender = encryptedForSender,
            CreatedAt = DateTime.UtcNow,
        };
        db.UserMessages.Add(msg);

        if (voiceAssetUuids.Count > 0)
        {
            var assets = await db.UserMessageVoiceAssets
                .Where(a => voiceAssetUuids.Contains(a.VoiceAssetUuid))
                .ToListAsync(ct);
            foreach (var a in assets)
                a.MessageUuid = msg.MessageUuid;
        }

        if (imageAssetUuids.Count > 0)
        {
            var assets = await db.UserMessageImageAssets
                .Where(a => imageAssetUuids.Contains(a.ImageAssetUuid))
                .ToListAsync(ct);
            foreach (var a in assets)
                a.MessageUuid = msg.MessageUuid;
        }

        if (videoAssetUuids.Count > 0)
        {
            var assets = await db.UserMessageVideoAssets
                .Where(a => videoAssetUuids.Contains(a.VideoAssetUuid))
                .ToListAsync(ct);
            foreach (var a in assets)
                a.MessageUuid = msg.MessageUuid;
        }

        await db.SaveChangesAsync(ct);
        return new SendMessageResult(msg.MessageUuid, msg.CreatedAt, encryptedForSender);
    }

    /// <inheritdoc/>
    public async Task MarkReadAsync(Guid viewerUuid, Guid otherUserUuid, CancellationToken ct)
    {
        var toUpdate = await db.UserMessages
            .Where(m => m.SenderUserUuid == otherUserUuid &&
                        m.ReceiverUserUuid == viewerUuid &&
                        !m.IsRead)
            .ToListAsync(ct);

        if (toUpdate.Count == 0) return;

        foreach (var m in toUpdate)
            m.IsRead = true;

        await db.SaveChangesAsync(ct);
    }

    /// <inheritdoc/>
    public Task<int> GetTotalUnreadCountAsync(Guid userUuid, CancellationToken ct) =>
        db.UserMessages.AsNoTracking()
            .Where(m => m.ReceiverUserUuid == userUuid && !m.IsRead)
            .Select(m => m.SenderUserUuid)
            .Distinct()
            .CountAsync(ct);

    /// <inheritdoc/>
    public async Task<DeleteMessageResult> DeleteMessageAsync(
        Guid viewerUuid,
        Guid conversationUuid,
        Guid messageUuid,
        CancellationToken ct)
    {
        var msg = await db.UserMessages.FirstOrDefaultAsync(m => m.MessageUuid == messageUuid, ct);
        if (msg is null)
            return DeleteMessageResult.NotFound;

        var msgConversationUuid = UuidV5.DmConversationUuid(msg.SenderUserUuid, msg.ReceiverUserUuid);
        if (msgConversationUuid != conversationUuid)
            return DeleteMessageResult.NotFound;

        if (msg.SenderUserUuid != viewerUuid)
            return DeleteMessageResult.Forbidden;

        db.UserMessages.Remove(msg);
        await db.SaveChangesAsync(ct);
        return DeleteMessageResult.Success;
    }
}
