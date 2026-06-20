namespace Flora.Auth.Application;

public sealed class SecurityStatusOutcome
{
    public bool TwoFactorEnabled { get; init; }
    public bool EmailVerified { get; init; }
    public bool PhoneVerified { get; init; }
}

public sealed class EmailChangeBeginOutcome
{
    public bool Success { get; init; }
    public string? ErrorMessage { get; init; }
    public bool IsConflict { get; init; }
    public string? ChangeToken { get; init; }
    public DateTime? ExpiresAtUtc { get; init; }
    public string? DevVerificationCode { get; init; }
}

public sealed class EmailChangeConfirmOutcome
{
    public bool Success { get; init; }
    public string? ErrorMessage { get; init; }
    public string? NewEmail { get; init; }
}

public sealed class SimpleSecurityOutcome
{
    public bool Success { get; init; }
    public string? ErrorMessage { get; init; }
}

public sealed class TwoFactorSetupOutcome
{
    public bool Success { get; init; }
    public string? ErrorMessage { get; init; }
    public string? Secret { get; init; }
    public string? OtpAuthUri { get; init; }
}

public interface IAuthAccountSecurityService
{
    Task<SecurityStatusOutcome> GetStatusAsync(Guid userUuid, CancellationToken cancellationToken);

    Task<EmailChangeBeginOutcome> BeginEmailChangeAsync(Guid userUuid, string password, string newEmail, CancellationToken cancellationToken);

    Task<EmailChangeConfirmOutcome> ConfirmEmailChangeAsync(Guid userUuid, string changeToken, string code, CancellationToken cancellationToken);

    Task<SimpleSecurityOutcome> ChangePhoneAsync(Guid userUuid, string password, string phone, CancellationToken cancellationToken);

    Task<TwoFactorSetupOutcome> BeginTwoFactorSetupAsync(Guid userUuid, string password, CancellationToken cancellationToken);

    Task<SimpleSecurityOutcome> EnableTwoFactorAsync(Guid userUuid, string code, CancellationToken cancellationToken);

    Task<SimpleSecurityOutcome> DisableTwoFactorAsync(Guid userUuid, string password, string code, CancellationToken cancellationToken);
}
