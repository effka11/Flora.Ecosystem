using Flora.Notifications.Application;
using Flora.Auth.Infrastructure;
using Flora.Users.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Flora.Social;

public sealed class SocialUserDisplayNameResolver(
    AuthDbContext auth,
    UsersDbContext users) : IUserDisplayNameResolver
{
    public async Task<string> ResolveDisplayNameAsync(Guid userUuid, CancellationToken ct = default)
    {
        var account = await auth.UserAccounts.AsNoTracking()
            .FirstOrDefaultAsync(a => a.UserUuid == userUuid, ct);
        var profile = await users.UserProfiles.AsNoTracking()
            .FirstOrDefaultAsync(p => p.UserUuid == userUuid, ct);

        var username = account?.Username ?? "";
        var displayName = profile?.DisplayName?.Trim();
        if (!string.IsNullOrEmpty(displayName)) return displayName;
        if (username.Length > 0) return $"@{username}";
        return "Пользователь";
    }
}
