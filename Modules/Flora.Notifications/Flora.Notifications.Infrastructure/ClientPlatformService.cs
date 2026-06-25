using Flora.Notifications.Application;
using Flora.Notifications.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Notifications.Infrastructure;

public sealed class ClientPlatformService(NotificationsDbContext db) : IClientPlatformService
{
    public async Task TouchAsync(Guid userUuid, string platform, CancellationToken ct = default)
    {
        if (userUuid == Guid.Empty) return;

        var plat = NormalizePlatform(platform);
        var existing = await db.UserClientPlatforms
            .FirstOrDefaultAsync(r => r.UserUuid == userUuid && r.Platform == plat, ct);

        if (existing is not null)
        {
            existing.UpdatedAt = DateTime.UtcNow;
        }
        else
        {
            db.UserClientPlatforms.Add(new UserClientPlatform
            {
                UserUuid = userUuid,
                Platform = plat,
                UpdatedAt = DateTime.UtcNow,
            });
        }

        await db.SaveChangesAsync(ct);
    }

    public async Task<IReadOnlyList<Guid>> ListUserUuidsAsync(string platform, CancellationToken ct = default) =>
        await db.UserClientPlatforms.AsNoTracking()
            .Where(r => r.Platform == NormalizePlatform(platform))
            .Select(r => r.UserUuid)
            .Distinct()
            .ToListAsync(ct);

    private static string NormalizePlatform(string platform)
    {
        var p = platform.Trim().ToLowerInvariant();
        return p is "ios" or "web" ? p : "android";
    }
}
