using System.Security.Claims;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.DependencyInjection;

namespace Flora.Social;

/// <summary>
/// Rate-limit policy names and registration for the Social product's HTTP surface.
/// Anonymous auth endpoints are partitioned by the client IP (read from the proxy-forwarded
/// <c>X-Forwarded-For</c> header, falling back to the socket address); authenticated endpoints are
/// partitioned by the JWT subject (falling back to IP). Enforcement requires
/// <c>app.UseRateLimiter()</c> in the API host. Limits are coarse abuse caps — the primary
/// brute-force control for login is the per-account lockout in the Auth module.
/// </summary>
public static class SocialRateLimitPolicies
{
    public const string Login = "social-login";
    public const string Register = "social-register";
    public const string Verify = "social-verify";
    public const string Refresh = "social-refresh";
    public const string AccountSensitive = "social-account-sensitive";
    public const string Write = "social-write";
    public const string Upload = "social-upload";

    public static IServiceCollection AddSocialRateLimitPolicies(this IServiceCollection services)
    {
        services.AddRateLimiter(opts =>
        {
            opts.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

            AddFixedWindow(opts, Login, ClientIp, permitLimit: 10, windowMinutes: 5);
            AddFixedWindow(opts, Register, ClientIp, permitLimit: 8, windowMinutes: 15);
            AddFixedWindow(opts, Verify, ClientIp, permitLimit: 12, windowMinutes: 15);
            AddFixedWindow(opts, Refresh, ClientIp, permitLimit: 60, windowMinutes: 5);
            AddFixedWindow(opts, AccountSensitive, UserOrIp, permitLimit: 10, windowMinutes: 15);
            AddFixedWindow(opts, Write, UserOrIp, permitLimit: 60, windowMinutes: 5);
            AddFixedWindow(opts, Upload, UserOrIp, permitLimit: 30, windowMinutes: 10);
        });
        return services;
    }

    private static void AddFixedWindow(
        RateLimiterOptions opts,
        string policy,
        Func<HttpContext, string> partitionKey,
        int permitLimit,
        int windowMinutes) =>
        opts.AddPolicy(policy, ctx => RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: partitionKey(ctx),
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = permitLimit,
                Window = TimeSpan.FromMinutes(windowMinutes),
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                QueueLimit = 0,
            }));

    private static string UserOrIp(HttpContext ctx) =>
        ctx.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? ClientIp(ctx);

    /// <summary>
    /// Best-effort client IP. Prefers the first <c>X-Forwarded-For</c> hop so that, behind the
    /// Next.js/nginx proxy, each real client gets its own bucket instead of every request sharing
    /// the proxy's socket address (which would throttle all users together). The socket address is
    /// the fallback when no forwarded header is present.
    /// </summary>
    private static string ClientIp(HttpContext ctx)
    {
        var forwarded = ctx.Request.Headers["X-Forwarded-For"].ToString();
        if (!string.IsNullOrWhiteSpace(forwarded))
        {
            var first = forwarded.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (first.Length > 0)
                return first[0];
        }
        return ctx.Connection.RemoteIpAddress?.ToString() ?? "anon";
    }
}
