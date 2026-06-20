using System.Security.Cryptography;
using System.Text;
using Flora.Auth.Application;
using Flora.Auth.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using OtpNet;

namespace Flora.Auth.Infrastructure.Services;

public sealed class AuthAccountSecurityService(
    AuthDbContext auth,
    IPasswordHasher passwordHasher,
    IVerificationCodeSender verificationCodeSender,
    IHostEnvironment hostEnvironment) : IAuthAccountSecurityService
{
    private const int PendingExpirationMinutes = 15;
    private const string TotpIssuer = "FLORA";

    public async Task<SecurityStatusOutcome> GetStatusAsync(Guid userUuid, CancellationToken cancellationToken)
    {
        var account = await auth.UserAccounts.AsNoTracking()
            .FirstOrDefaultAsync(u => u.UserUuid == userUuid, cancellationToken)
            .ConfigureAwait(false);
        if (account == null)
            return new SecurityStatusOutcome();

        return new SecurityStatusOutcome
        {
            TwoFactorEnabled = account.TwoFactorEnabled,
            EmailVerified = account.EmailVerified,
            PhoneVerified = account.PhoneVerified,
        };
    }

    public async Task<EmailChangeBeginOutcome> BeginEmailChangeAsync(
        Guid userUuid,
        string password,
        string newEmail,
        CancellationToken cancellationToken)
    {
        var email = (newEmail ?? "").Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(email) || !email.Contains('@'))
            return FailEmailBegin("Укажите корректный email.");
        if (string.IsNullOrWhiteSpace(password))
            return FailEmailBegin("Укажите пароль.");

        var account = await auth.UserAccounts.FirstOrDefaultAsync(u => u.UserUuid == userUuid, cancellationToken)
            .ConfigureAwait(false);
        if (account == null)
            return FailEmailBegin("Аккаунт не найден.");
        if (!passwordHasher.Verify(password, account.PasswordHash))
            return FailEmailBegin("Неверный пароль.");

        var currentEmail = (account.Email ?? "").Trim().ToLowerInvariant();
        if (currentEmail == email)
            return FailEmailBegin("Новый email совпадает с текущим.");

        if (await auth.UserAccounts.AnyAsync(u => u.Email == email && u.UserUuid != userUuid, cancellationToken).ConfigureAwait(false))
            return ConflictEmailBegin("Этот email уже используется.");

        await CleanupExpiredPendingEmailChangesAsync(cancellationToken).ConfigureAwait(false);

        var code = GenerateVerificationCode();
        var changeToken = Guid.NewGuid();
        var now = DateTime.UtcNow;
        var expiresAt = now.AddMinutes(PendingExpirationMinutes);
        var codeHash = HashVerificationCode(code);

        var existing = await auth.PendingEmailChanges
            .FirstOrDefaultAsync(p => p.UserUuid == userUuid, cancellationToken)
            .ConfigureAwait(false);
        if (existing != null)
        {
            existing.NewEmail = email;
            existing.VerificationCodeHash = codeHash;
            existing.ChangeToken = changeToken;
            existing.ExpiresAt = expiresAt;
            existing.UpdatedAt = now;
        }
        else
        {
            auth.PendingEmailChanges.Add(new PendingEmailChange
            {
                ChangeToken = changeToken,
                UserUuid = userUuid,
                NewEmail = email,
                VerificationCodeHash = codeHash,
                ExpiresAt = expiresAt,
                CreatedAt = now,
                UpdatedAt = now,
            });
        }

        await auth.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await verificationCodeSender.SendEmailVerificationCodeAsync(email, code, cancellationToken).ConfigureAwait(false);

        return new EmailChangeBeginOutcome
        {
            Success = true,
            ChangeToken = changeToken.ToString("D"),
            ExpiresAtUtc = expiresAt,
            DevVerificationCode = hostEnvironment.IsDevelopment() ? code : null,
        };
    }

    public async Task<EmailChangeConfirmOutcome> ConfirmEmailChangeAsync(
        Guid userUuid,
        string changeTokenRaw,
        string code,
        CancellationToken cancellationToken)
    {
        if (!Guid.TryParse(changeTokenRaw, out var changeToken))
            return FailEmailConfirm("Некорректный токен смены email.");
        if (string.IsNullOrWhiteSpace(code))
            return FailEmailConfirm("Укажите код подтверждения.");

        var pending = await auth.PendingEmailChanges
            .FirstOrDefaultAsync(p => p.ChangeToken == changeToken && p.UserUuid == userUuid, cancellationToken)
            .ConfigureAwait(false);
        if (pending == null || pending.ExpiresAt <= DateTime.UtcNow)
            return FailEmailConfirm("Запрос на смену email истёк. Начните заново.");

        if (!FixedTimeHashEquals(pending.VerificationCodeHash, HashVerificationCode(code.Trim())))
            return FailEmailConfirm("Неверный код подтверждения.");

        var account = await auth.UserAccounts.FirstOrDefaultAsync(u => u.UserUuid == userUuid, cancellationToken)
            .ConfigureAwait(false);
        if (account == null)
            return FailEmailConfirm("Аккаунт не найден.");

        if (await auth.UserAccounts.AnyAsync(u => u.Email == pending.NewEmail && u.UserUuid != userUuid, cancellationToken).ConfigureAwait(false))
            return FailEmailConfirm("Этот email уже используется.");

        account.Email = pending.NewEmail;
        account.HasEmail = true;
        account.EmailVerified = true;
        account.UpdatedAt = DateTime.UtcNow;
        auth.PendingEmailChanges.Remove(pending);
        await auth.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

        return new EmailChangeConfirmOutcome
        {
            Success = true,
            NewEmail = pending.NewEmail,
        };
    }

    public async Task<SimpleSecurityOutcome> ChangePhoneAsync(
        Guid userUuid,
        string password,
        string phone,
        CancellationToken cancellationToken)
    {
        var normalized = NormalizePhone(phone);
        if (string.IsNullOrWhiteSpace(normalized))
            return FailSimple("Укажите номер телефона.");
        if (string.IsNullOrWhiteSpace(password))
            return FailSimple("Укажите пароль.");

        var account = await auth.UserAccounts.FirstOrDefaultAsync(u => u.UserUuid == userUuid, cancellationToken)
            .ConfigureAwait(false);
        if (account == null)
            return FailSimple("Аккаунт не найден.");
        if (!passwordHasher.Verify(password, account.PasswordHash))
            return FailSimple("Неверный пароль.");

        if (string.Equals(account.Phone, normalized, StringComparison.Ordinal)
            && account.PhoneVerified)
            return FailSimple("Новый номер совпадает с текущим.");

        if (await auth.UserAccounts.AnyAsync(u => u.Phone == normalized && u.UserUuid != userUuid, cancellationToken).ConfigureAwait(false))
            return FailSimple("Этот номер уже используется.");

        account.Phone = normalized;
        account.PhoneVerified = false;
        account.UpdatedAt = DateTime.UtcNow;
        await auth.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

        return new SimpleSecurityOutcome { Success = true };
    }

    public async Task<TwoFactorSetupOutcome> BeginTwoFactorSetupAsync(
        Guid userUuid,
        string password,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(password))
            return FailTwoFactorSetup("Укажите пароль.");

        var account = await auth.UserAccounts.FirstOrDefaultAsync(u => u.UserUuid == userUuid, cancellationToken)
            .ConfigureAwait(false);
        if (account == null)
            return FailTwoFactorSetup("Аккаунт не найден.");
        if (!passwordHasher.Verify(password, account.PasswordHash))
            return FailTwoFactorSetup("Неверный пароль.");
        if (account.TwoFactorEnabled)
            return FailTwoFactorSetup("2FA уже включена. Сначала отключите её.");

        var secretBytes = RandomNumberGenerator.GetBytes(20);
        var secret = Base32Encoding.ToString(secretBytes);
        account.TwoFactorSecret = secret;
        account.TwoFactorEnabled = false;
        account.UpdatedAt = DateTime.UtcNow;
        await auth.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

        var email = account.Email ?? account.Username;
        var uri = new OtpUri(OtpType.Totp, secret, email, TotpIssuer).ToString();

        return new TwoFactorSetupOutcome
        {
            Success = true,
            Secret = secret,
            OtpAuthUri = uri,
        };
    }

    public async Task<SimpleSecurityOutcome> EnableTwoFactorAsync(
        Guid userUuid,
        string code,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(code))
            return FailSimple("Укажите код из приложения.");

        var account = await auth.UserAccounts.FirstOrDefaultAsync(u => u.UserUuid == userUuid, cancellationToken)
            .ConfigureAwait(false);
        if (account == null)
            return FailSimple("Аккаунт не найден.");
        if (string.IsNullOrWhiteSpace(account.TwoFactorSecret))
            return FailSimple("Сначала начните настройку 2FA.");
        if (account.TwoFactorEnabled)
            return FailSimple("2FA уже включена.");

        if (!VerifyTotp(account.TwoFactorSecret, code))
            return FailSimple("Неверный код из приложения.");

        account.TwoFactorEnabled = true;
        account.UpdatedAt = DateTime.UtcNow;
        await auth.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

        return new SimpleSecurityOutcome { Success = true };
    }

    public async Task<SimpleSecurityOutcome> DisableTwoFactorAsync(
        Guid userUuid,
        string password,
        string code,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(password))
            return FailSimple("Укажите пароль.");
        if (string.IsNullOrWhiteSpace(code))
            return FailSimple("Укажите код из приложения.");

        var account = await auth.UserAccounts.FirstOrDefaultAsync(u => u.UserUuid == userUuid, cancellationToken)
            .ConfigureAwait(false);
        if (account == null)
            return FailSimple("Аккаунт не найден.");
        if (!account.TwoFactorEnabled || string.IsNullOrWhiteSpace(account.TwoFactorSecret))
            return FailSimple("2FA не включена.");
        if (!passwordHasher.Verify(password, account.PasswordHash))
            return FailSimple("Неверный пароль.");
        if (!VerifyTotp(account.TwoFactorSecret, code))
            return FailSimple("Неверный код из приложения.");

        account.TwoFactorEnabled = false;
        account.TwoFactorSecret = null;
        account.UpdatedAt = DateTime.UtcNow;
        await auth.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

        return new SimpleSecurityOutcome { Success = true };
    }

    private static bool VerifyTotp(string secret, string code) => TotpCodes.Verify(secret, code);

    private static string NormalizePhone(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "";
        var digits = new string(raw.Where(char.IsDigit).ToArray());
        if (digits.Length == 0) return "";
        if (digits.StartsWith('8') && digits.Length == 11)
            digits = "7" + digits[1..];
        if (digits.Length == 10)
            digits = "7" + digits;
        return digits.Length > 20 ? digits[..20] : digits;
    }

    private async Task CleanupExpiredPendingEmailChangesAsync(CancellationToken cancellationToken)
    {
        var now = DateTime.UtcNow;
        var expired = await auth.PendingEmailChanges.Where(p => p.ExpiresAt <= now).ToListAsync(cancellationToken).ConfigureAwait(false);
        if (expired.Count == 0) return;
        auth.PendingEmailChanges.RemoveRange(expired);
        await auth.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    }

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

    private static EmailChangeBeginOutcome FailEmailBegin(string message) =>
        new() { Success = false, ErrorMessage = message };

    private static EmailChangeBeginOutcome ConflictEmailBegin(string message) =>
        new() { Success = false, IsConflict = true, ErrorMessage = message };

    private static EmailChangeConfirmOutcome FailEmailConfirm(string message) =>
        new() { Success = false, ErrorMessage = message };

    private static SimpleSecurityOutcome FailSimple(string message) =>
        new() { Success = false, ErrorMessage = message };

    private static TwoFactorSetupOutcome FailTwoFactorSetup(string message) =>
        new() { Success = false, ErrorMessage = message };
}
