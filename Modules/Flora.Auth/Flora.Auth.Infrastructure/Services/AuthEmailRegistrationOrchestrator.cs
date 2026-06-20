using System.Security.Cryptography;
using System.Text;
using Flora.Auth.Application;
using Flora.Auth.Domain;
using Flora.Auth.Infrastructure.Options;
using Flora.Shared;
using Flora.Users.Contracts;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace Flora.Auth.Infrastructure.Services;

public sealed class AuthEmailRegistrationOrchestrator(
    AuthDbContext auth,
    IPasswordHasher passwordHasher,
    IVerificationCodeSender verificationCodeSender,
    ITokenService tokenService,
    IOptions<JwtOptions> jwtOptions,
    IHostEnvironment hostEnvironment,
    IUserProfileProvisioner profileProvisioner) : IAuthEmailRegistrationOrchestrator
{
    private const int PendingExpirationMinutes = 15;

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
        var code = GenerateVerificationCode();
        var verificationToken = FloraUuid.NewGuid();
        var now = DateTime.UtcNow;
        var expiresAt = now.AddMinutes(PendingExpirationMinutes);

        var existingPending = await auth.PendingRegistrations
            .FirstOrDefaultAsync(p => p.Email == email, cancellationToken)
            .ConfigureAwait(false);

        var codeHash = HashVerificationCode(code);
        if (existingPending != null)
        {
            existingPending.PasswordHash = passwordHash;
            existingPending.VerificationCodeHash = codeHash;
            existingPending.ExpiresAt = expiresAt;
            existingPending.UpdatedAt = now;
            // VerificationToken is the PK — reuse it on retry (e.g. after SMTP failure).
            verificationToken = existingPending.VerificationToken;
        }
        else
        {
            var username = BuildUsernameFromEmail(email);
            auth.PendingRegistrations.Add(new PendingRegistration
            {
                VerificationToken = verificationToken,
                Email = email,
                Username = username,
                PasswordHash = passwordHash,
                VerificationCodeHash = codeHash,
                ExpiresAt = expiresAt,
                CreatedAt = now,
                UpdatedAt = now
            });
        }

        await auth.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

        try
        {
            await verificationCodeSender.SendEmailVerificationCodeAsync(email, code, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is System.Net.Mail.SmtpException or InvalidOperationException)
        {
            return FailBegin("Не удалось отправить код на email. Сервис почты временно недоступен — попробуйте позже.");
        }

        return new RegistrationBeginOutcome
        {
            Success = true,
            VerificationToken = verificationToken,
            ExpiresAtUtc = expiresAt,
            DevVerificationCode = hostEnvironment.IsDevelopment() ? code : null
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
        {
            auth.PendingRegistrations.Remove(pending);
            await auth.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            return FailAuth("Код верификации истек.");
        }

        if (!FixedTimeHashEquals(pending.VerificationCodeHash, HashVerificationCode(codePlain.Trim())))
            return FailAuth("Неверный код из сообщения.");

        if (await auth.UserAccounts.AnyAsync(u => u.Email == pending.Email, cancellationToken).ConfigureAwait(false))
        {
            auth.PendingRegistrations.Remove(pending);
            await auth.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
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

        auth.PendingRegistrations.Remove(pending);
        await auth.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await profileProvisioner.EnsureInitialProfileAsync(userUuid, "", cancellationToken).ConfigureAwait(false);

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

    private static string GenerateVerificationCode()
    {
        var value = RandomNumberGenerator.GetInt32(0, 1_000_000);
        return value.ToString("D6");
    }

    private static string HashVerificationCode(string code)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(code));
        return Convert.ToHexString(bytes);
    }

    /// <summary>Constant-time comparison of two code hashes to avoid leaking match progress via timing.</summary>
    private static bool FixedTimeHashEquals(string expected, string actual) =>
        CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(expected ?? ""),
            Encoding.ASCII.GetBytes(actual ?? ""));
}
