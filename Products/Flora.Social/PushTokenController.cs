using System.Security.Claims;
using Flora.Notifications.Application;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Flora.Social;

[ApiController]
[Route("api/auth/push-token")]
[Authorize]
public sealed class PushTokenController(IPushTokenService pushTokens, ILogger<PushTokenController> log) : ControllerBase
{
    [HttpPut]
    [HttpPost]
    public async Task<IActionResult> Register([FromBody] PushTokenRequest request, CancellationToken ct = default)
    {
        if (!TryGetUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var token = request.Token?.Trim();
        if (string.IsNullOrEmpty(token))
            return BadRequest(new { error = "Укажите push token." });

        var platform = string.IsNullOrWhiteSpace(request.Platform) ? "android" : request.Platform.Trim();
        await pushTokens.RegisterAsync(userUuid, token, platform, ct);
        log.LogInformation(
            "Push token registered for user {UserUuid} ({Platform}, prefix {Prefix})",
            userUuid,
            platform,
            token.Length > 8 ? token[..8] : token);
        return NoContent();
    }

    [HttpDelete]
    public async Task<IActionResult> Unregister([FromBody] PushTokenRequest request, CancellationToken ct = default)
    {
        if (!TryGetUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var token = request.Token?.Trim();
        if (string.IsNullOrEmpty(token))
            return BadRequest(new { error = "Укажите push token." });

        await pushTokens.UnregisterAsync(userUuid, token, ct);
        return NoContent();
    }

    private bool TryGetUserUuid(out Guid userUuid)
    {
        userUuid = Guid.Empty;
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        return !string.IsNullOrEmpty(sub) && Guid.TryParse(sub, out userUuid);
    }
}

public record PushTokenRequest(string? Token, string? Platform);
