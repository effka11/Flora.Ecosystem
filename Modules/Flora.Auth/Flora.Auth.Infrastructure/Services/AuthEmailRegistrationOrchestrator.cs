using Flora.Auth.Application;
using Flora.Auth.Domain;
using Flora.Auth.Infrastructure.Options;
using Flora.Shared;
using Flora.Users.Contracts;
using Flora.Verification.Contracts;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Flora.Auth.Infrastructure.Services;

public sealed class AuthEmailRegistrationOrchestrator(
    AuthDbContext auth,
    IPasswordHasher passwordHasher,
    IVerificationChallengeService verification,
    ITokenService tokenService,
    IOptions<JwtOptions> jwtOptions,
    IUserProfileProvisioner profileProvisioner,
    ILogger<AuthEmailRegistrationOrchestrator> logger) : IAuthEmailRegistrationOrchestrator
{
    public async Task<RegistrationBeginOutcome> BeginAsync(string emailOrEmpty, string password, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(password))
            return FailBegin("Пароль обязателен.");

        var email = (emailOrEmpty ?? "").Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(email) || !email.Contains('@'))
            return FailBegin("Укажите корректный email.");

        await CleanupExpiredPendingAsync(cancellationToken).ConfigureAwait(false);

        if (await auth.UserAccounts.AnyAsync(u => u.Email == email, cancellationToken).ConfigureAwait(false))
            return ConflictBegin("Аккаунт с этим email уже существует.");

        var passwordHash = passwordHasher.Hash(password);
        var username = BuildUsernameFromEmail(email);

        // Issue the challenge first (also sends the code). On a delivery failure we return early WITHOUT
        // touching any existing draft, so a retry that fails to email does not destroy prior state.
        ChallengeBeginResult challenge;
        try
        {
            challenge = await verification
                .BeginAsync(VerificationChallengeKind.EmailRegistration, email, null, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is System.Net.Mail.SmtpException or InvalidOperationException)
        {
            return FailBegin("Не удалось отправить код на email. Сервис почты временно недоступен — попробуйте позже.");
        }

        // Replace any prior draft for this email with one keyed by the new challenge token.
        var supersededTokens = new List<Guid>();
        var existingPending = await auth.PendingRegistrations
            .Where(p => p.Email == email)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (existingPending.Count > 0)
        {
            supersededTokens.AddRange(existingPending.Select(p => p.VerificationToken));
            auth.PendingRegistrations.RemoveRange(existingPending);
        }

        var now = DateTime.UtcNow;
        auth.PendingRegistrations.Add(new PendingRegistration
        {
            VerificationToken = challenge.Token,
            Email = email,
            Username = username,
            PasswordHash = passwordHash,
            ExpiresAt = challenge.ExpiresAtUtc,
            CreatedAt = now,
            UpdatedAt = now
        });
        await auth.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

        // Drafts are gone; their now-orphaned challenges self-expire, but cancel best-effort to free them sooner.
        foreach (var token in supersededTokens.Where(t => t != challenge.Token))
            await SafeCancelChallengeAsync(token, cancellationToken).ConfigureAwait(false);

        return new RegistrationBeginOutcome
        {
            Success = true,
            VerificationToken = challenge.Token,
            ExpiresAtUtc = challenge.ExpiresAtUtc,
            DevVerificationCode = challenge.DevCode
        };
    }

    public async Task<AuthenticatedSessionOutcome> CompleteVerificationAsync(
        Guid verificationToken,
        string codePlain,
        RemoteSessionHints sessionHints,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(codePlain))
            return FailAuth("Введите код из сообщения.");

        await CleanupExpiredPendingAsync(cancellationToken).ConfigureAwait(false);

        var pending = await auth.PendingRegistrations
            .FirstOrDefaultAsync(p => p.VerificationToken == verificationToken, cancellationToken)
            .ConfigureAwait(false);

        if (pending == null)
            return FailAuth("Токен верификации истек или недействителен.");

        if (pending.ExpiresAt <= DateTime.UtcNow)
            return await ExpirePendingAsync(pending, verificationToken, "Код верификации истек.", cancellationToken).ConfigureAwait(false);

        var validation = await verification.ValidateAsync(verificationToken, codePlain, cancellationToken).ConfigureAwait(false);
        if (!validation.Success)
        {
            return validation.Status switch
            {
                ChallengeValidateStatus.Expired =>
                    await ExpirePendingAsync(pending, verificationToken, "Код верификации истек.", cancellationToken).ConfigureAwait(false),
                ChallengeValidateStatus.NotFound =>
                    await ExpirePendingAsync(pending, verificationToken, "Токен верификации истек или недействителен.", cancellationToken).ConfigureAwait(false),
                _ => FailAuth("Неверный код из сообщения.")
            };
        }

        if (await auth.UserAccounts.AnyAsync(u => u.Email == pending.Email, cancellationToken).ConfigureAwait(false))
        {
            auth.PendingRegistrations.Remove(pending);
            await auth.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            await SafeCancelChallengeAsync(verificationToken, cancellationToken).ConfigureAwait(false);
            return ConflictAuth("Аккаунт с этим email уже существует.");
        }

        var userUuid = FloraUuid.NewGuid();
        var account = UserAccount.CreateForPhoneRegistration(userUuid, $"e-{userUuid.ToString("N")[..18]}", pending.Username, pending.PasswordHash);
        account.Email = pending.Email;
        account.HasEmail = true;
        account.EmailVerified = true;
        account.PrivacyAccepted = false;
        account.TosAccepted = false;
        account.UpdatedAt = DateTime.UtcNow;

        auth.UserAccounts.Add(account);
        auth.UserSecurityLogs.Add(new UserSecurityLogs { UserUuid = userUuid, PasswordUpdatedAt = DateTime.UtcNow });

        var jwtId = tokenService.GenerateJwtId();
        var refreshToken = tokenService.GenerateRefreshToken();
        var expiresAtAccess = DateTime.UtcNow.AddMinutes(jwtOptions.Value.AccessTokenMinutes);
        var refreshExpires = DateTime.UtcNow.AddDays(jwtOptions.Value.RefreshTokenDays);

        auth.UserSessions.Add(new UserSession
        {
            UserUuid = userUuid,
            AgentHash = sessionHints.AgentHash,
            IpAddress = sessionHints.Ip,
            ExpiresAt = refreshExpires,
            JwtId = jwtId,
            RefreshToken = refreshToken,
            CsrfToken = tokenService.GenerateCsrfToken(),
            HmacKey = tokenService.GenerateHmacKey(),
            Status = UserSessionStatus.Active
        });

        // One SaveChanges commits account + session and removes the draft atomically in AuthDbContext.
        auth.PendingRegistrations.Remove(pending);
        await auth.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await profileProvisioner.EnsureInitialProfileAsync(userUuid, "", cancellationToken).ConfigureAwait(false);

        // Account exists and draft is gone; consume the challenge best-effort (TTL covers any failure).
        await SafeCancelChallengeAsync(verificationToken, cancellationToken).ConfigureAwait(false);

        var (accessToken, _, _) = tokenService.CreateTokenPair(userUuid, pending.Email, jwtId, refreshToken);

        return new AuthenticatedSessionOutcome
        {
            Success = true,
            UserUuid = userUuid,
            AccessToken = accessToken,
            RefreshToken = refreshToken,
            AccessExpiresAtUtc = expiresAtAccess
        };
    }

    public async Task CancelAsync(Guid verificationToken, CancellationToken cancellationToken)
    {
        // Architect's guidance: no distributed transaction across Auth/Verification contexts. Remove the
        // local draft first (so an "eternal" draft is impossible), then best-effort cancel the challenge.
        var pending = await auth.PendingRegistrations
            .FirstOrDefaultAsync(p => p.VerificationToken == verificationToken, cancellationToken)
            .ConfigureAwait(false);
        if (pending != null)
        {
            auth.PendingRegistrations.Remove(pending);
            await auth.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        }

        await SafeCancelChallengeAsync(verificationToken, cancellationToken).ConfigureAwait(false);
    }

    private async Task<AuthenticatedSessionOutcome> ExpirePendingAsync(
        PendingRegistration pending,
        Guid verificationToken,
        string message,
        CancellationToken cancellationToken)
    {
        auth.PendingRegistrations.Remove(pending);
        await auth.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await SafeCancelChallengeAsync(verificationToken, cancellationToken).ConfigureAwait(false);
        return FailAuth(message);
    }

    private async Task SafeCancelChallengeAsync(Guid verificationToken, CancellationToken cancellationToken)
    {
        try
        {
            await verification.CancelAsync(verificationToken, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // Best-effort: an orphaned challenge self-expires via TTL. Never fail the caller on cleanup.
            logger.LogWarning(ex, "Best-effort cancel of verification challenge {Token} failed.", verificationToken);
        }
    }

    private static AuthenticatedSessionOutcome ConflictAuth(string message) =>
        new() { Success = false, IsConflict = true, ErrorMessage = message };

    private static AuthenticatedSessionOutcome FailAuth(string message) =>
        new() { Success = false, ErrorMessage = message };

    private static RegistrationBeginOutcome FailBegin(string message) =>
        new() { Success = false, ErrorMessage = message };

    private static RegistrationBeginOutcome ConflictBegin(string message) =>
        new() { Success = false, IsConflict = true, ErrorMessage = message };

    private async Task CleanupExpiredPendingAsync(CancellationToken cancellationToken)
    {
        var now = DateTime.UtcNow;
        var expired = await auth.PendingRegistrations.Where(p => p.ExpiresAt <= now).ToListAsync(cancellationToken).ConfigureAwait(false);
        if (expired.Count == 0) return;
        auth.PendingRegistrations.RemoveRange(expired);
        await auth.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    }

    private static string BuildUsernameFromEmail(string emailValue)
    {
        var basePart = emailValue.Split('@')[0].Trim();
        if (string.IsNullOrWhiteSpace(basePart)) basePart = "user";
        var normalized = NormalizeUsername(basePart);
        if (string.IsNullOrWhiteSpace(normalized)
            || normalized.Length < 2
            || normalized.All(c => c == '_')
            || ReservedUsernames.IsReserved(normalized))
            return $"user_{FloraUuid.NewGuid().ToString("N")[..8]}";
        return normalized;
    }

    private static string NormalizeUsername(string? raw) => LatinIdentifiers.NormalizeUsername(raw);
}
