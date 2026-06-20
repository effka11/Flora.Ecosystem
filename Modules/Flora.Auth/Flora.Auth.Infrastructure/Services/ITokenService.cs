using System.Security.Claims;

namespace Flora.Auth.Infrastructure.Services;

public interface ITokenService
{
    (string AccessToken, string RefreshToken, DateTime ExpiresAt) CreateTokenPair(
        Guid userUuid,
        string email,
        string jwtId,
        string refreshToken);

    ClaimsPrincipal? ValidateAccessToken(string token);
    string GenerateJwtId();
    string GenerateRefreshToken();
    string GenerateCsrfToken();
    string GenerateHmacKey();
}
