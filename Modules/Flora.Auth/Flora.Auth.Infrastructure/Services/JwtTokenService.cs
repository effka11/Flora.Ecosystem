using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Flora.Auth.Infrastructure.Options;
using Flora.Shared;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

namespace Flora.Auth.Infrastructure.Services;

public sealed class JwtTokenService : ITokenService
{
    private readonly JwtOptions _options;
    private readonly JwtSecurityTokenHandler _tokenHandler = new();
    private static readonly RandomNumberGenerator Rng = RandomNumberGenerator.Create();

    public JwtTokenService(IOptions<JwtOptions> options) => _options = options.Value;

    public (string AccessToken, string RefreshToken, DateTime ExpiresAt) CreateTokenPair(
        Guid userUuid,
        string email,
        string jwtId,
        string refreshToken)
    {
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_options.Secret));
        var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);
        var expires = DateTime.UtcNow.AddMinutes(_options.AccessTokenMinutes);

        var claims = new[]
        {
            new Claim(JwtRegisteredClaimNames.Sub, userUuid.ToString()),
            new Claim(JwtRegisteredClaimNames.Email, email),
            new Claim(JwtRegisteredClaimNames.Jti, jwtId),
            new Claim(ClaimTypes.NameIdentifier, userUuid.ToString()),
            new Claim(ClaimTypes.Email, email)
        };

        var token = new JwtSecurityToken(
            _options.Issuer,
            _options.Audience,
            claims,
            expires: expires,
            signingCredentials: creds);

        var accessToken = _tokenHandler.WriteToken(token);
        return (accessToken, refreshToken, expires);
    }

    public ClaimsPrincipal? ValidateAccessToken(string token)
    {
        if (string.IsNullOrWhiteSpace(_options.Secret)) return null;

        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_options.Secret));
        var validation = new TokenValidationParameters
        {
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = key,
            ValidIssuer = _options.Issuer,
            ValidAudience = _options.Audience,
            ValidateLifetime = true,
            ClockSkew = TimeSpan.FromMinutes(1)
        };

        try
        {
            return _tokenHandler.ValidateToken(token, validation, out _);
        }
        catch
        {
            return null;
        }
    }

    public string GenerateJwtId() => FloraUuid.NewGuid().ToString("N");
    public string GenerateRefreshToken() => Convert.ToBase64String(GetRandomBytes(64));
    public string GenerateCsrfToken() => Convert.ToBase64String(GetRandomBytes(32));
    public string GenerateHmacKey() => Convert.ToBase64String(GetRandomBytes(64));

    private static byte[] GetRandomBytes(int count)
    {
        var bytes = new byte[count];
        Rng.GetBytes(bytes);
        return bytes;
    }
}
