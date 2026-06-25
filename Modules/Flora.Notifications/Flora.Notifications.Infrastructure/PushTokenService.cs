using Flora.Notifications.Application;
using Flora.Notifications.Contracts;
using Flora.Notifications.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Notifications.Infrastructure;

public sealed class PushTokenService(NotificationsDbContext db) : IPushTokenService
{
    public async Task RegisterAsync(Guid userUuid, string token, string platform, CancellationToken ct = default)
    {
        var normalized = token.Trim();
        if (normalized.Length == 0) return;

        var plat = NormalizePlatform(platform);
        var existing = await db.UserPushTokens
            .FirstOrDefaultAsync(t => t.Token == normalized, ct);

        if (existing is not null)
        {
            existing.UserUuid = userUuid;
            existing.Platform = plat;
            existing.UpdatedAt = DateTime.UtcNow;
        }
        else
        {
            db.UserPushTokens.Add(new UserPushToken
            {
                UserUuid = userUuid,
                Token = normalized,
                Platform = plat,
                UpdatedAt = DateTime.UtcNow,
            });
        }

        await db.SaveChangesAsync(ct);
    }

    public async Task UnregisterAsync(Guid userUuid, string token, CancellationToken ct = default)
    {
        var normalized = token.Trim();
        if (normalized.Length == 0) return;

        var row = await db.UserPushTokens
            .FirstOrDefaultAsync(t => t.UserUuid == userUuid && t.Token == normalized, ct);
        if (row is null) return;

        db.UserPushTokens.Remove(row);
        await db.SaveChangesAsync(ct);
    }

    public async Task<IReadOnlyList<string>> GetTokensForUserAsync(Guid userUuid, CancellationToken ct = default) =>
        await db.UserPushTokens.AsNoTracking()
            .Where(t => t.UserUuid == userUuid)
            .OrderByDescending(t => t.UpdatedAt)
            .Select(t => t.Token)
            .ToListAsync(ct);

    public async Task<IReadOnlyList<Guid>> ListUserUuidsByPlatformAsync(string platform, CancellationToken ct = default)
    {
        var plat = NormalizePlatform(platform);
        return await db.UserPushTokens.AsNoTracking()
            .Where(t => t.Platform == plat)
            .Select(t => t.UserUuid)
            .Distinct()
            .ToListAsync(ct);
    }

    private static string NormalizePlatform(string platform)
    {
        var p = platform.Trim().ToLowerInvariant();
        return p == "ios" ? "ios" : "android";
    }
}
