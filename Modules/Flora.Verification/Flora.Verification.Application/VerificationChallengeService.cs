using System.Security.Cryptography;
using System.Text;
using Flora.Shared;
using Flora.Verification.Contracts;
using Flora.Verification.Domain;
using Microsoft.Extensions.Hosting;

namespace Flora.Verification.Application;

/// <summary>
/// Owns the verification lifecycle: generates a 6-digit code, stores only its SHA-256 hash with a
/// 15-minute TTL, validates in constant time, and lazily purges expired challenges. Code delivery is
/// delegated to <see cref="IVerificationCodeSender"/>; storage to <see cref="IVerificationChallengeRepository"/>.
/// </summary>
public sealed class VerificationChallengeService(
    IVerificationChallengeRepository repository,
    IVerificationCodeSender codeSender,
    IHostEnvironment hostEnvironment) : IVerificationChallengeService
{
    private const int ExpirationMinutes = 15;
    private const int MaxAttempts = 5;

    public async Task<ChallengeBeginResult> BeginAsync(
        VerificationChallengeKind kind,
        string target,
        Guid? subjectUserUuid,
        CancellationToken ct)
    {
        var normalizedTarget = (target ?? "").Trim().ToLowerInvariant();
        var now = DateTime.UtcNow;

        await repository.RemoveExpiredAsync(now, ct).ConfigureAwait(false);

        var code = GenerateCode();
        var challenge = new VerificationChallenge
        {
            Token = FloraUuid.NewGuid(),
            Kind = (int)kind,
            Target = normalizedTarget,
            SubjectUserUuid = subjectUserUuid,
            CodeHash = HashCode(code),
            ExpiresAt = now.AddMinutes(ExpirationMinutes),
            CreatedAt = now,
            UpdatedAt = now,
            Attempts = 0,
        };

        await repository.AddAsync(challenge, ct).ConfigureAwait(false);

        // Delivery comes last: a send failure leaves only a TTL-bounded challenge, never a stuck caller draft.
        await codeSender.SendEmailVerificationCodeAsync(normalizedTarget, code, ct).ConfigureAwait(false);

        return new ChallengeBeginResult(
            challenge.Token,
            challenge.ExpiresAt,
            hostEnvironment.IsDevelopment() ? code : null);
    }

    public async Task<ChallengeValidateResult> ValidateAsync(Guid token, string codePlain, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(codePlain))
            return new ChallengeValidateResult(ChallengeValidateStatus.CodeMismatch, null, null);

        var challenge = await repository.FindByTokenAsync(token, ct).ConfigureAwait(false);
        if (challenge is null)
            return new ChallengeValidateResult(ChallengeValidateStatus.NotFound, null, null);

        if (challenge.ExpiresAt <= DateTime.UtcNow)
        {
            await repository.RemoveAsync(challenge, ct).ConfigureAwait(false);
            return new ChallengeValidateResult(ChallengeValidateStatus.Expired, null, null);
        }

        if (!FixedTimeHashEquals(challenge.CodeHash, HashCode(codePlain.Trim())))
        {
            challenge.Attempts += 1;
            if (challenge.Attempts >= MaxAttempts)
                await repository.RemoveAsync(challenge, ct).ConfigureAwait(false);
            else
                await repository.UpdateAsync(challenge, ct).ConfigureAwait(false);
            return new ChallengeValidateResult(ChallengeValidateStatus.CodeMismatch, null, null);
        }

        return new ChallengeValidateResult(
            ChallengeValidateStatus.Success,
            challenge.Target,
            challenge.SubjectUserUuid);
    }

    public async Task CancelAsync(Guid token, CancellationToken ct)
    {
        var challenge = await repository.FindByTokenAsync(token, ct).ConfigureAwait(false);
        if (challenge is null) return; // idempotent: removing a missing token is a no-op
        await repository.RemoveAsync(challenge, ct).ConfigureAwait(false);
    }

    private static string GenerateCode() => RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");

    private static string HashCode(string code) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(code)));

    /// <summary>Constant-time comparison of two code hashes to avoid leaking match progress via timing.</summary>
    private static bool FixedTimeHashEquals(string expected, string actual) =>
        CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(expected ?? ""),
            Encoding.ASCII.GetBytes(actual ?? ""));
}
