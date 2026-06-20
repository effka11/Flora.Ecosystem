using Flora.Notifications.Application;
using Flora.Notifications.Contracts;
using Flora.Notifications.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Notifications.Infrastructure;

public sealed class NotificationInboxService(
    NotificationsDbContext db,
    IUserRealtimePublisher realtimePublisher) : INotificationInboxService
{
    public async Task DispatchAsync(CreateUserNotificationCommand command, CancellationToken ct = default)
    {
        if (command.RecipientUserUuid == Guid.Empty) return;
        if (command.ActorUserUuid is Guid actor && actor == command.RecipientUserUuid) return;

        var text = command.Text.Trim();
        if (text.Length == 0) return;

        var row = new UserNotification
        {
            RecipientUserUuid = command.RecipientUserUuid,
            ActorUserUuid = command.ActorUserUuid,
            Type = NormalizeType(command.Type),
            Category = NormalizeCategory(command.Category),
            Text = text.Length <= 500 ? text : text[..500],
            PostUuid = command.PostUuid,
            CommentUuid = command.CommentUuid,
            IsRead = false,
        };

        db.UserNotifications.Add(row);
        await db.SaveChangesAsync(ct);

        var signal = new RealtimeNotificationSignal(
            row.NotificationUuid,
            row.Type,
            row.Category,
            row.Text,
            row.ActorUserUuid,
            row.PostUuid,
            row.CommentUuid,
            row.CreatedAt);

        await realtimePublisher.PublishNotificationAsync(command.RecipientUserUuid, signal, ct);
    }

    public async Task<IReadOnlyList<NotificationDto>> ListAsync(
        Guid recipientUserUuid,
        string? category,
        string? search,
        int skip,
        int take,
        CancellationToken ct = default)
    {
        if (take <= 0) return Array.Empty<NotificationDto>();
        take = Math.Min(take, 100);
        skip = Math.Max(0, skip);

        var query = db.UserNotifications.AsNoTracking()
            .Where(n => n.RecipientUserUuid == recipientUserUuid);

        var normalizedCategory = NormalizeCategoryOrNull(category);
        if (normalizedCategory is not null)
            query = query.Where(n => n.Category == normalizedCategory);

        var q = search?.Trim();
        if (!string.IsNullOrEmpty(q))
            query = query.Where(n => EF.Functions.ILike(n.Text, $"%{q}%"));

        var rows = await query
            .OrderByDescending(n => n.CreatedAt)
            .Skip(skip)
            .Take(take)
            .Select(n => new NotificationDto(
                n.NotificationUuid,
                n.Type,
                n.Category,
                n.Text,
                n.CreatedAt,
                n.IsRead,
                n.PostUuid,
                n.CommentUuid,
                null))
            .ToListAsync(ct);

        return rows;
    }

    public Task<int> GetUnreadCountAsync(Guid recipientUserUuid, CancellationToken ct = default) =>
        db.UserNotifications.AsNoTracking()
            .CountAsync(n => n.RecipientUserUuid == recipientUserUuid && !n.IsRead, ct);

    public async Task<bool> MarkReadAsync(Guid recipientUserUuid, Guid notificationUuid, CancellationToken ct = default)
    {
        var row = await db.UserNotifications
            .FirstOrDefaultAsync(n => n.NotificationUuid == notificationUuid && n.RecipientUserUuid == recipientUserUuid, ct);
        if (row is null || row.IsRead) return row is not null;
        row.IsRead = true;
        await db.SaveChangesAsync(ct);
        return true;
    }

    public Task<int> MarkAllReadAsync(Guid recipientUserUuid, CancellationToken ct = default) =>
        db.UserNotifications
            .Where(n => n.RecipientUserUuid == recipientUserUuid && !n.IsRead)
            .ExecuteUpdateAsync(s => s.SetProperty(n => n.IsRead, true), ct);

    public async Task<int> DeleteAsync(DeleteNotificationsCommand command, CancellationToken ct = default)
    {
        if (command.NotificationUuids.Count == 0) return 0;
        var ids = command.NotificationUuids.Distinct().ToList();
        var rows = await db.UserNotifications
            .Where(n => n.RecipientUserUuid == command.RecipientUserUuid && ids.Contains(n.NotificationUuid))
            .ToListAsync(ct);
        if (rows.Count == 0) return 0;
        db.UserNotifications.RemoveRange(rows);
        await db.SaveChangesAsync(ct);
        return rows.Count;
    }

    public async Task<int> DeleteAllAsync(Guid recipientUserUuid, CancellationToken ct = default)
    {
        var rows = await db.UserNotifications
            .Where(n => n.RecipientUserUuid == recipientUserUuid)
            .ToListAsync(ct);
        if (rows.Count == 0) return 0;
        db.UserNotifications.RemoveRange(rows);
        await db.SaveChangesAsync(ct);
        return rows.Count;
    }

    private static string NormalizeType(string type)
    {
        var t = type.Trim().ToLowerInvariant();
        return t is "like" or "reply" or "follow" or "developer" or "default" ? t : "default";
    }

    private static string NormalizeCategory(string category)
    {
        var c = category.Trim().ToLowerInvariant();
        return c == "developer" ? "developer" : "social";
    }

    private static string? NormalizeCategoryOrNull(string? category)
    {
        if (string.IsNullOrWhiteSpace(category) || category.Equals("all", StringComparison.OrdinalIgnoreCase))
            return null;
        return NormalizeCategory(category);
    }
}
