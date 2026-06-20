using Flora.Messaging.Contracts;

namespace Flora.Notifications.Infrastructure;

internal static class MessagePushPreviewBuilder
{
    public static string Build(MessageSentPushContext? context)
    {
        if (context?.PushPreview is { Length: > 0 } preview)
            return Truncate(preview);

        if (context?.HasVoiceAttachment == true) return "Голосовое сообщение";
        if (context?.HasImageAttachment == true) return "Фото";
        if (context?.HasVideoAttachment == true) return "Видео";

        return "Новое сообщение";
    }

    private static string Truncate(string text) =>
        text.Length <= 120 ? text : text[..117] + "...";
}
