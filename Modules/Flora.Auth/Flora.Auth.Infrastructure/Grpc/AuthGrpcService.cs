using Flora.Auth.Application;
using Flora.Auth.Domain;
using Flora.Auth.Infrastructure.Options;
using Flora.Auth.Infrastructure.Services;
using Flora.Grpc;
using Flora.Users.Contracts;
using Grpc.Core;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using System.Security.Claims;

namespace Flora.Auth.Infrastructure.Grpc;

public sealed class AuthGrpcService : AuthService.AuthServiceBase
{
    private readonly AuthDbContext _db;
    private readonly IAuthEmailRegistrationOrchestrator _registration;
    private readonly IAuthCredentialOperations _credentials;
    private readonly ITokenService _tokenService;
    private readonly IOptions<JwtOptions> _jwtOptions;
    private readonly IUserProfileReadQueries _profileRead;

    public AuthGrpcService(
        AuthDbContext db,
        IAuthEmailRegistrationOrchestrator registration,
        IAuthCredentialOperations credentials,
        ITokenService tokenService,
        IOptions<JwtOptions> jwtOptions,
        IUserProfileReadQueries profileRead)
    {
        _db = db;
        _registration = registration;
        _credentials = credentials;
        _tokenService = tokenService;
        _jwtOptions = jwtOptions;
        _profileRead = profileRead;
    }

    /// <inheritdoc />
    /// <remarks>Use <see cref="PendingEmailRegistrationPayload"/> / email verification flow (same as HTTP).</remarks>
    public override async Task<AuthResponse> Register(RegisterRequest request, ServerCallContext context)
    {
        var email = (request.Email ?? "").Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(email) || string.IsNullOrEmpty(request.Password))
            return new AuthResponse { Success = false, Message = "Email and password are required." };

        var outcome = await _registration.BeginAsync(email, request.Password, context.CancellationToken).ConfigureAwait(false);

        if (!outcome.Success)
        {
            return new AuthResponse
            {
                Success = false,
                Message = outcome.ErrorMessage ?? "Registration failed."
            };
        }

        return new AuthResponse
        {
            Success = true,
            Message = "Check your email for the verification code.",
            PendingRegistration = new PendingEmailRegistrationPayload
            {
                VerificationToken = outcome.VerificationToken.ToString("D"),
                ExpiresAt = new DateTimeOffset(outcome.ExpiresAtUtc, TimeSpan.Zero).ToUnixTimeSeconds()
            }
        };
    }

    public override async Task<AuthResponse> Login(LoginRequest request, ServerCallContext context)
    {
        var identifier = (request.Identifier ?? "").Trim();
        var ipRaw = request.IpAddress ?? "";
        var ip = ipRaw.Length > 45 ? ipRaw[..45] : ipRaw;
        if (string.IsNullOrEmpty(ip))
            ip = TruncateIp(context.GetHttpContext()?.Connection?.RemoteIpAddress?.ToString() ?? "unknown");
        var userAgent = request.UserAgent ?? context.GetHttpContext()?.Request.Headers.UserAgent.ToString() ?? "";
        var agentHash = HashString(userAgent);

        var outcome = await _credentials.LoginByPasswordAsync(
                identifier,
                request.Password ?? "",
                twoFactorCode: null,
                new RemoteSessionHints(ip, agentHash),
                context.CancellationToken)
            .ConfigureAwait(false);

        if (!outcome.Success)
        {
            if (outcome.RequiresTwoFactor)
                return new AuthResponse { Success = false, Message = "Two-factor authentication is required; use the HTTP login endpoint." };
            return new AuthResponse { Success = false, Message = outcome.ErrorMessage ?? "Invalid credentials." };
        }

        var userUuid = outcome.UserUuid;
        return new AuthResponse
        {
            Success = true,
            Data = new AuthData
            {
                Token = outcome.AccessToken ?? "",
                RefreshToken = outcome.RefreshToken ?? "",
                ExpiresAt = new DateTimeOffset(outcome.AccessExpiresAtUtc).ToUnixTimeSeconds(),
                User = await ToUserProfileResponseAsync(userUuid, context.CancellationToken).ConfigureAwait(false),
                Session = new SessionInfo
                {
                    IpAddress = ip,
                    UserAgent = userAgent,
                    CreatedAt = new DateTimeOffset(DateTime.UtcNow).ToUnixTimeSeconds(),
                    ExpiresAt = new DateTimeOffset(DateTime.UtcNow.AddDays(_jwtOptions.Value.RefreshTokenDays)).ToUnixTimeSeconds()
                }
            }
        };
    }

    public override Task<ValidateTokenResponse> ValidateToken(ValidateTokenRequest request, ServerCallContext context)
    {
        var principal = _tokenService.ValidateAccessToken(request.Token ?? "");
        if (principal == null)
            return Task.FromResult(new ValidateTokenResponse { Valid = false });

        var sub = principal.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        var email = principal.FindFirst(ClaimTypes.Email)?.Value;
        // Return only the minimal identity. Do not echo every claim value back to callers.
        var response = new ValidateTokenResponse { Valid = true, UserUuid = sub ?? "", Username = email ?? "" };
        return Task.FromResult(response);
    }

    public override async Task<RefreshTokenResponse> RefreshToken(RefreshTokenRequest request, ServerCallContext context)
    {
        var outcome = await _credentials.RefreshAsync(request.RefreshToken ?? "", context.CancellationToken).ConfigureAwait(false);
        if (!outcome.Success)
            return new RefreshTokenResponse();

        return new RefreshTokenResponse
        {
            NewToken = outcome.AccessToken ?? "",
            NewRefreshToken = outcome.RefreshToken ?? "",
            ExpiresAt = new DateTimeOffset(outcome.AccessExpiresAtUtc).ToUnixTimeSeconds()
        };
    }

    public override async Task<UserProfileResponse> GetUserProfile(GetUserProfileRequest request, ServerCallContext context)
    {
        if (!Guid.TryParse(request.UserUuid, out var userUuid))
            throw new RpcException(new Status(StatusCode.InvalidArgument, "Invalid user_uuid"));

        var account = await _db.UserAccounts.AsNoTracking().FirstOrDefaultAsync(u => u.UserUuid == userUuid, context.CancellationToken).ConfigureAwait(false);
        if (account == null)
            throw new RpcException(new Status(StatusCode.NotFound, "User not found"));

        return await ToUserProfileResponseModelAsync(account, context.CancellationToken).ConfigureAwait(false);
    }

    private async Task<UserProfileResponse> ToUserProfileResponseAsync(Guid userUuid, CancellationToken ct)
    {
        var account = await _db.UserAccounts.AsNoTracking().FirstAsync(u => u.UserUuid == userUuid, ct).ConfigureAwait(false);
        return await ToUserProfileResponseModelAsync(account, ct).ConfigureAwait(false);
    }

    private async Task<UserProfileResponse> ToUserProfileResponseModelAsync(UserAccount account, CancellationToken ct)
    {
        var profile = await _profileRead.FindByUserUuidAsync(account.UserUuid, ct).ConfigureAwait(false);
        return new UserProfileResponse
        {
            UserUuid = account.UserUuid.ToString(),
            Username = account.Username,
            Phone = account.Phone,
            Email = account.Email ?? "",
            DisplayName = profile?.DisplayName ?? account.Username,
            AvatarUuid = profile?.AvatarUuid?.ToString() ?? "",
            Status = ((int)account.Status).ToString(),
            CreatedAt = new DateTimeOffset(account.CreatedAt).ToUnixTimeSeconds()
        };
    }

    private static string HashString(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        var bytes = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(s));
        var b64 = Convert.ToBase64String(bytes);
        return b64.Length > 64 ? b64[..64] : b64;
    }

    private static string TruncateIp(string ip)
    {
        if (string.IsNullOrEmpty(ip)) return "unknown";
        return ip.Length > 45 ? ip[..45] : ip;
    }
}
