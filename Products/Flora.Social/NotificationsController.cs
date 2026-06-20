using System.Security.Claims;
using Flora.Notifications.Application;
using Flora.Notifications.Contracts;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Flora.Social;

[ApiController]
[Route("api/auth/notifications")]
[Authorize]
public sealed class NotificationsController(INotificationInboxService notifications) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] string? category,
        [FromQuery] string? search,
        [FromQuery] int skip = 0,
        [FromQuery] int take = 50,
        CancellationToken ct = default)
    {
        if (!TryGetUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var items = await notifications.ListAsync(userUuid, category, search, skip, take, ct);
        return Ok(items.Select(n => new
        {
            notificationUuid = n.NotificationUuid,
            type = n.Type,
            category = n.Category,
            text = n.Text,
            createdAt = n.CreatedAt,
            isRead = n.IsRead,
            postUuid = n.PostUuid,
            commentUuid = n.CommentUuid,
        }));
    }

    [HttpGet("unread-count")]
    public async Task<IActionResult> UnreadCount(CancellationToken ct = default)
    {
        if (!TryGetUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var count = await notifications.GetUnreadCountAsync(userUuid, ct);
        return Ok(new { unreadCount = count });
    }

    [HttpPatch("{notificationUuid:guid}/read")]
    public async Task<IActionResult> MarkRead(Guid notificationUuid, CancellationToken ct = default)
    {
        if (!TryGetUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var ok = await notifications.MarkReadAsync(userUuid, notificationUuid, ct);
        if (!ok) return NotFound(new { error = "Уведомление не найдено." });
        return NoContent();
    }

    [HttpPost("read")]
    public async Task<IActionResult> MarkAllRead(CancellationToken ct = default)
    {
        if (!TryGetUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var marked = await notifications.MarkAllReadAsync(userUuid, ct);
        return Ok(new { marked });
    }

    [HttpDelete("all")]
    public async Task<IActionResult> DeleteAll(CancellationToken ct = default)
    {
        if (!TryGetUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var deleted = await notifications.DeleteAllAsync(userUuid, ct);
        return Ok(new { deleted });
    }

    [HttpDelete]
    public async Task<IActionResult> Delete([FromBody] DeleteNotificationsRequest request, CancellationToken ct = default)
    {
        if (!TryGetUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        if (request.NotificationUuids is null || request.NotificationUuids.Count == 0)
            return BadRequest(new { error = "Укажите уведомления для удаления." });
        var deleted = await notifications.DeleteAsync(
            new DeleteNotificationsCommand(userUuid, request.NotificationUuids),
            ct);
        return Ok(new { deleted });
    }

    private bool TryGetUserUuid(out Guid userUuid)
    {
        userUuid = Guid.Empty;
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        return !string.IsNullOrEmpty(sub) && Guid.TryParse(sub, out userUuid);
    }
}

public record DeleteNotificationsRequest(IReadOnlyList<Guid>? NotificationUuids);
