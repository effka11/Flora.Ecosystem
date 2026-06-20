using OtpNet;

namespace Flora.Auth.Infrastructure.Services;

/// <summary>Shared TOTP verification used by login enforcement and 2FA management.</summary>
internal static class TotpCodes
{
    public static bool Verify(string? base32Secret, string? code)
    {
        if (string.IsNullOrWhiteSpace(base32Secret) || string.IsNullOrWhiteSpace(code))
            return false;

        try
        {
            var totp = new Totp(Base32Encoding.ToBytes(base32Secret));
            return totp.VerifyTotp(code.Trim(), out _, new VerificationWindow(previous: 1, future: 1));
        }
        catch
        {
            return false;
        }
    }
}
