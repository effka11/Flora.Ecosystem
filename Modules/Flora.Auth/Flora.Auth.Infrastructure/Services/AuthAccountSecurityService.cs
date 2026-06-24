using System.Security.Cryptography;
using Flora.Auth.Application;
using Flora.Verification.Contracts;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using OtpNet;

namespace Flora.Auth.Infrastructure.Services;

public sealed class AuthAccountSecurityService(
    AuthDbContext auth,
    IPasswordHasher passwordHasher,
    IVerificationChallengeService verification,
    ILogger<AuthAccountSecurityService> logger) : IAuthAccountSecurityService
{
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

        // Verification owns the code/challenge; the change token returned to the client is the challenge token.
        ChallengeBeginResult challenge;
        try
        {
            challenge = await verification
                .BeginAsync(VerificationChallengeKind.EmailChange, email, userUuid, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is System.Net.Mail.SmtpException or InvalidOperationException)
        {
            return FailEmailBegin("Не удалось отправить код на email. Сервис почты временно недоступен — попробуйте позже.");
        }

        return new EmailChangeBeginOutcome
        {
            Success = true,
            ChangeToken = challenge.Token.ToString("D"),
            ExpiresAtUtc = challenge.ExpiresAtUtc,
            DevVerificationCode = challenge.DevCode,
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

        var validation = await verification.ValidateAsync(changeToken, code, cancellationToken).ConfigureAwait(false);
        if (!validation.Success)
        {
            return validation.Status == ChallengeValidateStatus.CodeMismatch
                ? FailEmailConfirm("Неверный код подтверждения.")
                : FailEmailConfirm("Запрос на смену email истёк. Начните заново.");
        }

        // Bind the challenge to the authenticated user and read the new email from its target.
        if (validation.SubjectUserUuid != userUuid || string.IsNullOrWhiteSpace(validation.Target))
            return FailEmailConfirm("Запрос на смену email истёк. Начните заново.");

        var newEmail = validation.Target;

        var account = await auth.UserAccounts.FirstOrDefaultAsync(u => u.UserUuid == userUuid, cancellationToken)
            .ConfigureAwait(false);
        if (account == null)
            return FailEmailConfirm("Аккаунт не найден.");

        if (await auth.UserAccounts.AnyAsync(u => u.Email == newEmail && u.UserUuid != userUuid, cancellationToken).ConfigureAwait(false))
            return FailEmailConfirm("Этот email уже используется.");

        account.Email = newEmail;
        account.HasEmail = true;
        account.EmailVerified = true;
        account.UpdatedAt = DateTime.UtcNow;
        await auth.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

        // Email applied in AuthDbContext; consume the challenge best-effort (TTL covers any failure).
        await SafeCancelChallengeAsync(changeToken, cancellationToken).ConfigureAwait(false);

        return new EmailChangeConfirmOutcome
        {
            Success = true,
            NewEmail = newEmail,
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

    private async Task SafeCancelChallengeAsync(Guid token, CancellationToken cancellationToken)
    {
        try
        {
            await verification.CancelAsync(token, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // Best-effort: an orphaned challenge self-expires via TTL. Never fail the caller on cleanup.
            logger.LogWarning(ex, "Best-effort cancel of email-change challenge {Token} failed.", token);
        }
    }

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
