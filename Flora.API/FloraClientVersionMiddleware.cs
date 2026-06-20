namespace Flora.API;

/// <summary>
/// Optional minimum mobile client version enforcement (426 Upgrade Required).
/// Configure FloraMobile:MinClientVersion in appsettings (e.g. "1.0.0"); empty = disabled.
/// </summary>
public sealed class FloraClientVersionMiddleware(RequestDelegate next, IConfiguration configuration)
{
    public async Task InvokeAsync(HttpContext context)
    {
        var minVersion = configuration["FloraMobile:MinClientVersion"]?.Trim();
        if (!string.IsNullOrEmpty(minVersion))
        {
            var header = context.Request.Headers["X-Flora-Client"].ToString();
            if (!string.IsNullOrWhiteSpace(header) && header.Contains('/'))
            {
                var slash = header.IndexOf('/');
                var clientVersion = slash >= 0 ? header[(slash + 1)..].Split('+')[0] : "";
                if (!string.IsNullOrWhiteSpace(clientVersion) &&
                    Version.TryParse(clientVersion, out var client) &&
                    Version.TryParse(minVersion, out var min) &&
                    client < min)
                {
                    context.Response.StatusCode = StatusCodes.Status426UpgradeRequired;
                    await context.Response.WriteAsJsonAsync(new
                    {
                        error = "Требуется обновление приложения.",
                        minClientVersion = minVersion,
                    });
                    return;
                }
            }
        }

        await next(context);
    }
}
