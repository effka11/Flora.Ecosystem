using System.Text.Json.Serialization;

namespace Flora.Messaging.Contracts;

/// <summary>Summary entry for the conversation list.</summary>
public sealed record ConversationSummary(
    Guid ConversationUuid,
    Guid OtherUserUuid,
    string? LastMessageEncryptedForMe,
    string? LastMessageContent,
    DateTime LastMessageAt,
    bool LastMessageIsFromMe,
    int UnreadCount);

/// <summary>Paged response for GET /api/messaging/conversations.</summary>
public sealed record ConversationsPage(
    IReadOnlyList<ConversationSummary> Items,
    string? NextCursor,
    bool HasMore);

/// <summary>A single message item in a conversation thread.</summary>
public sealed record MessageItem(
    Guid MessageUuid,
    Guid SenderUserUuid,
    string? EncryptedForMe,
    string? Content,
    DateTime CreatedAt,
    bool IsRead,
    bool IsFromMe,
    IReadOnlyList<Guid> VoiceAssetUuids,
    IReadOnlyList<Guid> ImageAssetUuids,
    IReadOnlyList<Guid> VideoAssetUuids);

/// <summary>Paged response for GET /api/messaging/conversations/{id}/messages.</summary>
public sealed record MessagesPage(
    IReadOnlyList<MessageItem> Items,
    string? NextCursor,
    bool HasMore);

/// <summary>Request body for POST /api/messaging/conversations/{id}/messages.</summary>
public sealed class PostConversationMessageRequest
{
    [JsonPropertyName("encryptedForReceiver")]
    public string EncryptedForReceiver { get; set; } = "";

    [JsonPropertyName("encryptedForSender")]
    public string EncryptedForSender { get; set; } = "";

    [JsonPropertyName("voiceAssetUuids")]
    public Guid[]? VoiceAssetUuids { get; set; }

    [JsonPropertyName("imageAssetUuids")]
    public Guid[]? ImageAssetUuids { get; set; }

    [JsonPropertyName("videoAssetUuids")]
    public Guid[]? VideoAssetUuids { get; set; }

    [JsonPropertyName("pushPreview")]
    public string? PushPreview { get; set; }
}

/// <summary>
/// Client-supplied preview for push notifications. Not persisted; plaintext must not be placed in FCM data.
/// </summary>
public sealed record MessageSentPushContext(
    string? PushPreview,
    bool HasVoiceAttachment = false,
    bool HasImageAttachment = false,
    bool HasVideoAttachment = false)
{
    public static MessageSentPushContext? FromRequest(
        string? pushPreview,
        bool hasVoice,
        bool hasImage,
        bool hasVideo)
    {
        var sanitized = Sanitize(pushPreview);
        if (sanitized is null && !hasVoice && !hasImage && !hasVideo)
            return null;

        return new MessageSentPushContext(sanitized, hasVoice, hasImage, hasVideo);
    }

    public static string? Sanitize(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;

        var t = raw.Trim();
        var sb = new System.Text.StringBuilder(t.Length);
        foreach (var ch in t)
        {
            if (ch is '\n' or '\r' or '\t' || !char.IsControl(ch))
                sb.Append(ch);
        }

        t = sb.ToString().Trim();
        if (t.Length == 0) return null;
        if (t.Length > 200) t = t[..200];
        return t;
    }
}

/// <summary>Row returned from the message repository — raw data before enrichment.</summary>
public sealed record MessageRow(
    Guid MessageUuid,
    Guid SenderUserUuid,
    string? EncryptedForMe,
    string? Content,
    DateTime CreatedAt,
    bool IsRead,
    bool IsFromMe,
    IReadOnlyList<Guid> VoiceAssetUuids,
    IReadOnlyList<Guid> ImageAssetUuids,
    IReadOnlyList<Guid> VideoAssetUuids);

/// <summary>Row returned from the conversation peer query.</summary>
public sealed record ConversationPeerRow(
    Guid OtherUserUuid,
    Guid LastMessageUuid,
    string? LastEncryptedForMe,
    string? LastContent,
    DateTime LastMessageAt,
    bool LastIsFromMe,
    int UnreadCount);

/// <summary>Result of a successful message send.</summary>
public sealed record SendMessageResult(
    Guid MessageUuid,
    DateTime CreatedAt,
    string EncryptedForSender);

/// <summary>Outcome of DELETE message for the current user.</summary>
public enum DeleteMessageResult
{
    NotFound,
    Forbidden,
    Success,
}
