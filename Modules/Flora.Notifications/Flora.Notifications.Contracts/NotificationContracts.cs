namespace Flora.Notifications.Contracts;

public record NotificationDto(
    Guid NotificationUuid,
    string Type,
    string Category,
    string Text,
    DateTime CreatedAt,
    bool IsRead,
    Guid? PostUuid,
    Guid? CommentUuid,
    string? ActorUsername);

public record CreateUserNotificationCommand(
    Guid RecipientUserUuid,
    Guid? ActorUserUuid,
    string Type,
    string Category,
    string Text,
    Guid? PostUuid = null,
    Guid? CommentUuid = null);

public record CreateBroadcastNotificationCommand(
    string Type,
    string Category,
    string Text,
    string? AudiencePlatform = null);

public record DeleteNotificationsCommand(Guid RecipientUserUuid, IReadOnlyList<Guid> NotificationUuids);

public record RegisterPushTokenCommand(Guid UserUuid, string Token, string Platform);

public record UnregisterPushTokenCommand(Guid UserUuid, string Token);
