using System.Security.Claims;
using Flora.Notifications.Application;
using Microsoft.AspNetCore.Http;

namespace Flora.Notifications;

public sealed class ClientPlatformTouchMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context, IClientPlatformService clientPlatforms)
    {
        if (context.User.Identity?.IsAuthenticated == true
            && Guid.TryParse(context.User.FindFirstValue(ClaimTypes.NameIdentifier), out var userUuid)
            && userUuid != Guid.Empty)
        {
            var platform = FloraClientHeader.TryGetPlatform(context.Request.Headers["X-Flora-Client"].ToString());
            if (platform is not null)
            {
                try
                {
                    await clientPlatforms.TouchAsync(userUuid, platform, context.RequestAborted);
                }
                catch
                {
                    // Presence tracking must not break API requests.
                }
            }
        }

        await next(context);
    }
}
