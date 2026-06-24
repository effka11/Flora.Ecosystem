namespace Flora.Verification.Application;

/// <summary>Delivers a verification code to a target (currently email). Implemented by Infrastructure.</summary>
public interface IVerificationCodeSender
{
    Task SendEmailVerificationCodeAsync(string email, string code, CancellationToken cancellationToken);
}
