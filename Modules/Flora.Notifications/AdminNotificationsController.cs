using System.Security.Cryptography;
using System.Text;
using Flora.Notifications.Application;
using Flora.Notifications.Contracts;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;

namespace Flora.Notifications;

[ApiController]
[Route("api/admin/notifications")]
public sealed class AdminNotificationsController(
    INotificationInboxService notifications,
    IConfiguration configuration) : ControllerBase
{
    private const string TokenHeaderName = "X-Flora-Admin-Token";

    [HttpPost("broadcast")]
    public async Task<IActionResult> Broadcast(
        [FromBody] BroadcastNotificationRequest request,
        CancellationToken ct = default)
    {
        var configuredToken = configuration["Flora:AdminBroadcastToken"]?.Trim();
        if (string.IsNullOrEmpty(configuredToken))
            return NotFound(new { error = "Админ-рассылка отключена." });

        var providedToken = Request.Headers[TokenHeaderName].ToString().Trim();
        if (!IsValidAdminToken(configuredToken, providedToken))
            return Unauthorized(new { error = "Неверный токен администратора." });

        var text = request.Text?.Trim() ?? "";
        if (text.Length == 0)
            return BadRequest(new { error = "Укажите текст уведомления." });

        var type = string.IsNullOrWhiteSpace(request.Type) ? "app_update" : request.Type.Trim();
        var category = string.IsNullOrWhiteSpace(request.Category) ? "developer" : request.Category.Trim();
        var platform = string.IsNullOrWhiteSpace(request.Platform) ? null : request.Platform.Trim();

        var recipients = await notifications.BroadcastAsync(
            new CreateBroadcastNotificationCommand(type, category, text, platform),
            ct);

        return Ok(new { recipients });
    }

    private static bool IsValidAdminToken(string configured, string provided)
    {
        if (provided.Length == 0) return false;
        var expected = Encoding.UTF8.GetBytes(configured);
        var actual = Encoding.UTF8.GetBytes(provided);
        return expected.Length == actual.Length
            && CryptographicOperations.FixedTimeEquals(expected, actual);
    }
}

public record BroadcastNotificationRequest(string? Text, string? Type, string? Category, string? Platform);
