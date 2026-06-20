using System.Text;
using Flora.Auth.Infrastructure.Options;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;

namespace Flora.Social;

public static class FloraJwtExtensions
{
    public static IServiceCollection AddFloraJwtBearer(this IServiceCollection services, IConfiguration configuration)
    {
        var jwt = configuration.GetSection(JwtOptions.SectionName).Get<JwtOptions>()
            ?? throw new InvalidOperationException($"Missing configuration section '{JwtOptions.SectionName}'.");
        if (string.IsNullOrWhiteSpace(jwt.Secret) || jwt.Secret.Length < 32)
            throw new InvalidOperationException(
                "Jwt:Secret must be set and at least 32 characters. Provide it via the Jwt__Secret environment " +
                "variable, appsettings.{Environment}.json, or appsettings.Local.json. Do not reuse example placeholders.");
        if (IsWeakOrPlaceholderSecret(jwt.Secret))
            throw new InvalidOperationException(
                "Jwt:Secret looks like a placeholder/example value. Generate a unique random secret of at least 32 bytes.");

        services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
            .AddJwtBearer(options =>
            {
                options.TokenValidationParameters = new TokenValidationParameters
                {
                    ValidateIssuerSigningKey = true,
                    IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwt.Secret)),
                    ValidateIssuer = true,
                    ValidIssuer = jwt.Issuer,
                    ValidateAudience = true,
                    ValidAudience = jwt.Audience,
                    ValidateLifetime = true,
                    ClockSkew = TimeSpan.FromMinutes(1)
                };
            });

        return services;
    }

    /// <summary>Development: mint ephemeral secret when unset or still an example placeholder.</summary>
    public static bool ShouldMintEphemeralDevelopmentSecret(string? secret) =>
        string.IsNullOrWhiteSpace(secret) || secret.Length < 32 || IsWeakOrPlaceholderSecret(secret);

    private static bool IsWeakOrPlaceholderSecret(string secret)
    {
        string[] forbidden =
        {
            "DevelopmentSecretKey",
            "ChangeInProduction",
            "__JWT_SECRET",
            "changeme",
            "change-me",
            "your-secret",
            "placeholder",
            "example",
        };

        foreach (var bad in forbidden)
        {
            if (secret.Contains(bad, StringComparison.OrdinalIgnoreCase))
                return true;
        }

        return false;
    }
}
