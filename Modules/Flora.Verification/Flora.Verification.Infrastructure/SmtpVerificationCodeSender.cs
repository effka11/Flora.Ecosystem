using System.Net;
using System.Net.Mail;
using Flora.Verification.Application;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Flora.Verification.Infrastructure;

public sealed class SmtpVerificationCodeSender(
    IOptions<SmtpOptions> options,
    ILogger<SmtpVerificationCodeSender> logger,
    IHostEnvironment hostEnvironment)
    : IVerificationCodeSender
{
    private readonly SmtpOptions _smtp = options.Value;

    public async Task SendEmailVerificationCodeAsync(string email, string code, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(_smtp.Host) || string.IsNullOrWhiteSpace(_smtp.FromEmail))
        {
            if (hostEnvironment.IsProduction())
            {
                throw new InvalidOperationException(
                    "SMTP is not configured for production. Set Smtp__Host, Smtp__FromEmail and credentials in flora-api.env.");
            }

            logger.LogInformation(
                "SMTP is not configured — email not sent. Verification code for {Email}: {Code}",
                email,
                code);
            return;
        }

        var port = _smtp.Port > 0 ? _smtp.Port : 587;
        var senderName = string.IsNullOrWhiteSpace(_smtp.FromName) ? "Flora" : _smtp.FromName;

        using var client = new SmtpClient(_smtp.Host, port)
        {
            EnableSsl = _smtp.EnableSsl,
            DeliveryMethod = SmtpDeliveryMethod.Network
        };
        if (!string.IsNullOrWhiteSpace(_smtp.Username))
            client.Credentials = new NetworkCredential(_smtp.Username, _smtp.Password);

        using var message = new MailMessage
        {
            From = new MailAddress(_smtp.FromEmail, senderName),
            Subject = "Flora ID: код подтверждения",
            Body =
                $"Ваш код подтверждения: {code}\n\nКод действует 15 минут и сбрасывается при выходе из окна регистрации.",
            IsBodyHtml = false
        };
        message.To.Add(email);
        await client.SendMailAsync(message, cancellationToken);
    }
}
