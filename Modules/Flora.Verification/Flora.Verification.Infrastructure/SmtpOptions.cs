namespace Flora.Verification.Infrastructure;

/// <summary>
/// SMTP settings bound from the existing "Smtp" configuration section. The section name is kept
/// unchanged so Smtp__* environment variables and Scripts/enable-prod-verification.ps1 keep working
/// after verification moved out of Auth.
/// </summary>
public sealed class SmtpOptions
{
    public const string SectionName = "Smtp";

    public string Host { get; set; } = "";
    public int Port { get; set; } = 587;
    public string Username { get; set; } = "";
    public string Password { get; set; } = "";
    public string FromEmail { get; set; } = "";
    public string FromName { get; set; } = "Flora";
    public bool EnableSsl { get; set; } = true;
}
