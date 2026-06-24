using Flora.Auth.Contracts;
using Flora.Notifications.Application;
using Flora.Users.Contracts;

namespace Flora.Notifications.Infrastructure;

/// <summary>
/// Resolves a user's display name through module contracts only (Users + Auth read queries), so the
/// Notifications module no longer needs a product-supplied bridge that reaches into other DbContexts.
/// Precedence: profile DisplayName → "@username" → "Пользователь".
/// </summary>
public sealed class UserDisplayNameResolver(
    IUserProfileReadQueries profiles,
    IAccountReadQueries accounts) : IUserDisplayNameResolver
{
    public async Task<string> ResolveDisplayNameAsync(Guid userUuid, CancellationToken ct = default)
    {
        var profile = await profiles.FindByUserUuidAsync(userUuid, ct).ConfigureAwait(false);
        var displayName = profile?.DisplayName?.Trim();
        if (!string.IsNullOrEmpty(displayName)) return displayName;

        var account = await accounts.FindByUuidAsync(userUuid, ct).ConfigureAwait(false);
        var username = account?.Username ?? "";
        if (username.Length > 0) return $"@{username}";

        return "Пользователь";
    }
}
