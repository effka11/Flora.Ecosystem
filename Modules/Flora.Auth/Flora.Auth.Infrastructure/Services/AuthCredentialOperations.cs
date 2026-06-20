using Flora.Auth.Application;
using Flora.Auth.Domain;
using Flora.Auth.Infrastructure.Options;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Flora.Auth.Infrastructure.Services;

public sealed class AuthCredentialOperations(
    AuthDbContext auth,
    IPasswordHasher passwordHasher,
    ITokenService tokenService,
    IOptions<JwtOptions> jwtOptions) : IAuthCredentialOperations
{
    // Per-account brute-force throttle. IP-independent, so it holds even when every request reaches
    // the API through the shared proxy IP. After MaxLoginFailures consecutive failures the account is
    // locked for LockoutMinutes; a successful login resets the counter.
    private const int MaxLoginFailures = 5;
    private const int LockoutMinutes = 15;

    public async Task<AuthenticatedSessionOutcome> LoginByPasswordAsync(
        string? emailOrPhone,
        string password,
        string? twoFactorCode,
        RemoteSessionHints sessionHints,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(password))
            return Fail("Пароль обязателен.");

        var identifier = (emailOrPhone ?? "").Trim();
        if (string.IsNullOrWhiteSpace(identifier))
            return Fail("Укажите email.");

        await CleanupExpiredPendingAsync(cancellationToken).ConfigureAwait(false);

        var user = await auth.UserAccounts.AsNoTracking()
            .FirstOrDefaultAsync(u =>
                    (u.Email == identifier || u.Phone == identifier) &&
                    u.Status == UserAccountStatus.Active,
                cancellationToken)
            .ConfigureAwait(false);

        // Do not reveal whether the identifier exists; a missing account looks like a bad password.
        if (user == null)
            return Fail("Неверный email или пароль.");

        var now = DateTime.UtcNow;
        var security = await auth.UserSecurityLogs
            .FirstOrDefaultAsync(s => s.UserUuid == user.UserUuid, cancellationToken)
            .ConfigureAwait(false);

        if (security?.LoginLockedUntil is { } lockedUntil && lockedUntil > now)
            return Fail("Слишком много неудачных попыток входа. Повторите попытку позже.");

        if (!passwordHasher.Verify(password, user.PasswordHash))
        {
            await RegisterLoginFailureAsync(security, user.UserUuid, now, cancellationToken).ConfigureAwait(false);
            return Fail("Неверный email или пароль.");
        }

        // Enforce 2FA: a valid password is not enough once TOTP is enabled.
        if (user.TwoFactorEnabled)
        {
            var code = (twoFactorCode ?? "").Trim();
            if (string.IsNullOrEmpty(code))
                return TwoFactorChallenge(null);
            if (!TotpCodes.Verify(user.TwoFactorSecret, code))
            {
                await RegisterLoginFailureAsync(security, user.UserUuid, now, cancellationToken).ConfigureAwait(false);
                return TwoFactorChallenge("Неверный код двухфакторной аутентификации.");
            }
        }

        var jwtId = tokenService.GenerateJwtId();
        var refreshToken = tokenService.GenerateRefreshToken();
        var expiresAt = DateTime.UtcNow.AddMinutes(jwtOptions.Value.AccessTokenMinutes);
        var refreshExpires = DateTime.UtcNow.AddDays(jwtOptions.Value.RefreshTokenDays);

        var session = new UserSession
        {
            UserUuid = user.UserUuid,
            AgentHash = sessionHints.AgentHash,
            IpAddress = sessionHints.Ip,
            ExpiresAt = refreshExpires,
            JwtId = jwtId,
            RefreshToken = refreshToken,
            CsrfToken = tokenService.GenerateCsrfToken(),
            HmacKey = tokenService.GenerateHmacKey(),
            Status = UserSessionStatus.Active
        };

        auth.UserSessions.Add(session);
        var tracked = await auth.UserAccounts.FindAsync([user.UserUuid], cancellationToken).ConfigureAwait(false);
        if (tracked != null)
            tracked.LastLogin = DateTime.UtcNow;

        if (security != null)
        {
            security.LoginFailures = 0;
            security.LoginLockedUntil = null;
            security.LastLogin = now;
            security.UpdatedAt = now;
        }

        await auth.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

        var tokenIdentifier = user.Email ?? user.Phone;
        var (accessToken, _, _) = tokenService.CreateTokenPair(user.UserUuid, tokenIdentifier, jwtId, refreshToken);

        return new AuthenticatedSessionOutcome
        {
            Success = true,
            UserUuid = user.UserUuid,
            AccessToken = accessToken,
            RefreshToken = refreshToken,
            AccessExpiresAtUtc = expiresAt
        };
    }

    public async Task<AuthenticatedSessionOutcome> RefreshAsync(string refreshToken, CancellationToken cancellationToken)
    {
        var token = refreshToken.Trim();
        if (string.IsNullOrEmpty(token))
            return Fail("Refresh token is required.");

        var session = await auth.UserSessions
            .FirstOrDefaultAsync(s =>
                    s.RefreshToken == token &&
                    s.Status == UserSessionStatus.Active &&
                    s.ExpiresAt > DateTime.UtcNow,
                cancellationToken)
            .ConfigureAwait(false);

        if (session == null)
            return Fail("Invalid or expired refresh token.");

        var user = await auth.UserAccounts.AsNoTracking().FirstAsync(u => u.UserUuid == session.UserUuid, cancellationToken)
            .ConfigureAwait(false);

        var identifier = user.Phone ?? user.Email ?? user.Username ?? "";

        var newJwtId = tokenService.GenerateJwtId();
        var newRefreshToken = tokenService.GenerateRefreshToken();
        session.JwtId = newJwtId;
        session.RefreshToken = newRefreshToken;
        session.ExpiresAt = DateTime.UtcNow.AddDays(jwtOptions.Value.RefreshTokenDays);
        session.LastActivity = DateTime.UtcNow;
        session.RotationId += 1;
        await auth.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

        var (accessToken, _, expiresAt) = tokenService.CreateTokenPair(user.UserUuid, identifier, newJwtId, newRefreshToken);

        return new AuthenticatedSessionOutcome
        {
            Success = true,
            UserUuid = user.UserUuid,
            AccessToken = accessToken,
            RefreshToken = newRefreshToken,
            AccessExpiresAtUtc = expiresAt
        };
    }

    private async Task RegisterLoginFailureAsync(
        UserSecurityLogs? security,
        Guid userUuid,
        DateTime now,
        CancellationToken cancellationToken)
    {
        if (security == null)
        {
            security = new UserSecurityLogs
            {
                UserUuid = userUuid,
                PasswordUpdatedAt = now,
                CreatedAt = now,
                UpdatedAt = now,
            };
            auth.UserSecurityLogs.Add(security);
        }

        var failures = security.LoginFailures + 1;
        if (failures >= MaxLoginFailures)
        {
            security.LoginFailures = 0;
            security.LoginLockedUntil = now.AddMinutes(LockoutMinutes);
        }
        else
        {
            security.LoginFailures = (byte)failures;
        }

        security.UpdatedAt = now;
        await auth.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    }

    private static AuthenticatedSessionOutcome Fail(string message) =>
        new() { Success = false, ErrorMessage = message };

    private static AuthenticatedSessionOutcome TwoFactorChallenge(string? message) =>
        new() { Success = false, RequiresTwoFactor = true, ErrorMessage = message };

    private async Task CleanupExpiredPendingAsync(CancellationToken cancellationToken)
    {
        var now = DateTime.UtcNow;
        var expired = await auth.PendingRegistrations.Where(p => p.ExpiresAt <= now).ToListAsync(cancellationToken).ConfigureAwait(false);
        if (expired.Count == 0) return;
        auth.PendingRegistrations.RemoveRange(expired);
        await auth.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    }
}
