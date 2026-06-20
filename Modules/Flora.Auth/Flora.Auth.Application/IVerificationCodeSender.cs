namespace Flora.Auth.Application;

public interface IVerificationCodeSender
{
    Task SendEmailVerificationCodeAsync(string email, string code, CancellationToken cancellationToken);
}
