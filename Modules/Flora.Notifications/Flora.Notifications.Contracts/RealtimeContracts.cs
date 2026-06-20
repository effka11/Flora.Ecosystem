namespace Flora.Notifications.Contracts;

public record RealtimeMessageSignal(
    Guid ConversationUuid,
    Guid SenderUserUuid,
    DateTime SentAt);

public record RealtimeNotificationSignal(
    Guid NotificationUuid,
    string Type,
    string Category,
    string Text,
    Guid? ActorUserUuid,
    Guid? PostUuid,
    Guid? CommentUuid,
    DateTime CreatedAt);
