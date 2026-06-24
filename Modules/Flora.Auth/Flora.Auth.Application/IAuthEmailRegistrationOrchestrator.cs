namespace Flora.Auth.Application;

public sealed record RemoteSessionHints(string Ip, string AgentHash);

/// <summary>Starts email-based registration with pending verification.</summary>
public interface IAuthEmailRegistrationOrchestrator
{
    Task<RegistrationBeginOutcome> BeginAsync(string emailOrEmpty, string password, CancellationToken cancellationToken);

    Task<AuthenticatedSessionOutcome> CompleteVerificationAsync(
        Guid verificationToken,
        string codePlain,
        RemoteSessionHints sessionHints,
        CancellationToken cancellationToken);

    /// <summary>
    /// Abandons a pending registration: removes the local account draft, then best-effort cancels the
    /// verification challenge. Safe to call repeatedly and when the token no longer exists.
    /// </summary>
    Task CancelAsync(Guid verificationToken, CancellationToken cancellationToken);
}

/// <summary>Password login + refresh-token rotation backed by Auth DB.</summary>
public interface IAuthCredentialOperations
{
    Task<AuthenticatedSessionOutcome> LoginByPasswordAsync(
        string? emailOrPhone,
        string password,
        string? twoFactorCode,
        RemoteSessionHints sessionHints,
        CancellationToken cancellationToken);

    Task<AuthenticatedSessionOutcome> RefreshAsync(string refreshToken, CancellationToken cancellationToken);
}

public sealed class RegistrationBeginOutcome
{
    public bool Success { get; init; }
    public Guid VerificationToken { get; init; }
    public DateTime ExpiresAtUtc { get; init; }
    public string? ErrorMessage { get; init; }
    public bool IsConflict { get; init; }

    /// <summary>Plain verification code for local Development only (never set in Production).</summary>
    public string? DevVerificationCode { get; init; }
}

public sealed class AuthenticatedSessionOutcome
{
    public bool Success { get; init; }
    public string? AccessToken { get; init; }
    public string? RefreshToken { get; init; }
    public DateTime AccessExpiresAtUtc { get; init; }
    public string? ErrorMessage { get; init; }

    /// <summary>HTTP 409 (e.g. email already registered during verify).</summary>
    public bool IsConflict { get; init; }

    /// <summary>
    /// Set when the credentials are valid but a TOTP code is still required (or was wrong).
    /// No tokens are issued in this case; the caller must re-submit with a valid code.
    /// </summary>
    public bool RequiresTwoFactor { get; init; }

    /// <summary>Set on successful login / refresh for callers that need profile without parsing JWT.</summary>
    public Guid UserUuid { get; init; }
}
