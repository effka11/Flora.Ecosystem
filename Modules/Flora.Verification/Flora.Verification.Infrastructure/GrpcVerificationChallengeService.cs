using System.Net.Mail;
using Flora.Grpc.Verification;
using Flora.Verification.Contracts;
using Grpc.Core;
using Grpc.Net.ClientFactory;

namespace Flora.Verification.Infrastructure;

/// Адаптер `IVerificationChallengeService` → gRPC Rust (Фаза 2a). Один писатель — Rust.
public sealed class GrpcVerificationChallengeService(
    VerificationChallengeService.VerificationChallengeServiceClient client)
    : IVerificationChallengeService
{
    public async Task<ChallengeBeginResult> BeginAsync(
        VerificationChallengeKind kind,
        string target,
        Guid? subjectUserUuid,
        CancellationToken ct)
    {
        try
        {
            var response = await client.BeginAsync(
                new BeginRequest
                {
                    Kind = (int)kind,
                    Target = target ?? "",
                    SubjectUserUuid = subjectUserUuid?.ToString("D") ?? "",
                },
                cancellationToken: ct).ConfigureAwait(false);

            if (!Guid.TryParse(response.Token, out var token))
                throw new InvalidOperationException("Verification gRPC returned invalid token.");

            if (!DateTime.TryParse(
                    response.ExpiresAtUtc,
                    null,
                    System.Globalization.DateTimeStyles.RoundtripKind,
                    out var expires))
                throw new InvalidOperationException("Verification gRPC returned invalid expires_at_utc.");

            string? devCode = string.IsNullOrEmpty(response.DevCode) ? null : response.DevCode;
            return new ChallengeBeginResult(token, expires.ToUniversalTime(), devCode);
        }
        catch (RpcException ex) when (ex.StatusCode == StatusCode.FailedPrecondition)
        {
            throw new InvalidOperationException(ex.Status.Detail, ex);
        }
        catch (RpcException ex) when (ex.StatusCode == StatusCode.Unavailable)
        {
            throw new SmtpException(ex.Status.Detail, ex);
        }
    }

    public async Task<ChallengeValidateResult> ValidateAsync(
        Guid token,
        string codePlain,
        CancellationToken ct)
    {
        var response = await client.ValidateAsync(
            new ValidateRequest
            {
                Token = token.ToString("D"),
                CodePlain = codePlain ?? "",
            },
            cancellationToken: ct).ConfigureAwait(false);

        var status = (ChallengeValidateStatus)response.Status;
        Guid? subject = null;
        if (!string.IsNullOrEmpty(response.SubjectUserUuid)
            && Guid.TryParse(response.SubjectUserUuid, out var parsed))
            subject = parsed;

        string? target = string.IsNullOrEmpty(response.Target) ? null : response.Target;
        return new ChallengeValidateResult(status, target, subject);
    }

    public async Task CancelAsync(Guid token, CancellationToken ct)
    {
        await client.CancelAsync(
            new CancelRequest { Token = token.ToString("D") },
            cancellationToken: ct).ConfigureAwait(false);
    }
}
