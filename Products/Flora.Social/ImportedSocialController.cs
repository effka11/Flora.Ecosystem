using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Flora.Auth.Application;
using Flora.Auth.Domain;
using Flora.Users.Domain;
using Flora.Content.Domain;
using Flora.Messaging.Domain;
using Flora.Content.Application.Feed;
using Flora.Content.Application.Videos;
using Flora.Content.Contracts;
using Flora.Users.Contracts;
using Flora.Auth.Infrastructure;
using Flora.Users.Infrastructure;
using Flora.Content.Infrastructure;
using Flora.Messaging.Infrastructure;
using Flora.Notifications.Application;
using Flora.Notifications.Contracts;
using Flora.Social.Models;
using Flora.Shared;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats;

namespace Flora.Social;

[ApiController]
[Route("api/auth")]
public sealed class ImportedSocialController : ControllerBase
{
    private const int MaxVoiceAssetDurationMs = 30 * 60 * 1000;
    // 30 мин @ 128 kbps + 25% запас (синхронно с Apps/Web voiceCapture VOICE_MAX_UPLOAD_BYTES).
    /// <summary>30 мин @ HE-AAC 48 kbps + 25% overhead (см. Apps/Web voiceCapture).</summary>
    private const long MaxVoiceAssetBytes = 14L * 1024 * 1024;
    private const long MaxMessageImageBytes = 5L * 1024 * 1024;

    private readonly AuthDbContext _auth;
    private readonly UsersDbContext _users;
    private readonly ContentDbContext _content;
    private readonly MessagingDbContext _msg;
    private readonly IAuthEmailRegistrationOrchestrator _authRegistration;
    private readonly IAuthCredentialOperations _authCredentials;
    private readonly IAuthAccountSecurityService _accountSecurity;
    private readonly IFeedRecommendationService _feedRecommendation;
    private readonly IContentFeedQueries _feedQueries;
    private readonly IFollowGraphReader _followGraph;
    private readonly ICommunityRecommendationService _communityRecommendation;
    private readonly IUserRecommendationService _userRecommendation;
    private readonly IUserPrivacySettingsService _privacySettings;
    private readonly IProfileAccessPolicy _profileAccess;
    private readonly IUserBlocklistService _blocklist;
    private readonly IUserPresenceService _presence;
    private readonly IPasswordHasher _passwordHasher;
    private readonly INotificationInboxService _notifications;
    private readonly IVideoTranscoder _videoTranscoder;
    private readonly IPostVideoTranscodeQueue _videoQueue;
    private readonly ILogger<ImportedSocialController> _log;

    public ImportedSocialController(
        AuthDbContext auth,
        UsersDbContext users,
        ContentDbContext content,
        MessagingDbContext msg,
        IAuthEmailRegistrationOrchestrator authRegistration,
        IAuthCredentialOperations authCredentials,
        IAuthAccountSecurityService accountSecurity,
        IFeedRecommendationService feedRecommendation,
        IContentFeedQueries feedQueries,
        IFollowGraphReader followGraph,
        ICommunityRecommendationService communityRecommendation,
        IUserRecommendationService userRecommendation,
        IUserPrivacySettingsService privacySettings,
        IProfileAccessPolicy profileAccess,
        IUserBlocklistService blocklist,
        IUserPresenceService presence,
        IPasswordHasher passwordHasher,
        INotificationInboxService notifications,
        IVideoTranscoder videoTranscoder,
        IPostVideoTranscodeQueue videoQueue,
        ILogger<ImportedSocialController> log)
    {
        _auth = auth;
        _users = users;
        _content = content;
        _msg = msg;
        _authRegistration = authRegistration;
        _authCredentials = authCredentials;
        _accountSecurity = accountSecurity;
        _feedRecommendation = feedRecommendation;
        _feedQueries = feedQueries;
        _followGraph = followGraph;
        _communityRecommendation = communityRecommendation;
        _userRecommendation = userRecommendation;
        _privacySettings = privacySettings;
        _profileAccess = profileAccess;
        _blocklist = blocklist;
        _presence = presence;
        _passwordHasher = passwordHasher;
        _notifications = notifications;
        _videoTranscoder = videoTranscoder;
        _videoQueue = videoQueue;
        _log = log;
    }

    [HttpPost("login")]
    [AllowAnonymous]
    [EnableRateLimiting(SocialRateLimitPolicies.Login)]
    public async Task<ActionResult<LoginResponse>> Login([FromBody] LoginRequest request, CancellationToken ct)
    {
        var identifier = ResolveIdentifier(request.Email, request.Phone);
        var (ip, agentHash) = GetRequestContext();
        var outcome = await _authCredentials.LoginByPasswordAsync(identifier, request.Password ?? "", request.TwoFactorCode, new RemoteSessionHints(ip, agentHash), ct);
        if (!outcome.Success)
        {
            if (outcome.RequiresTwoFactor)
                return Ok(new { requiresTwoFactor = true, error = outcome.ErrorMessage });
            if (outcome.ErrorMessage is "Укажите email." or "Пароль обязателен.")
                return BadRequest(new { error = outcome.ErrorMessage });
            return Unauthorized(new { error = outcome.ErrorMessage });
        }

        var requiresProfile = await RequiresProfileCompletionAsync(outcome.UserUuid, ct);
        return Ok(new LoginResponse(
            outcome.AccessToken!,
            outcome.RefreshToken!,
            outcome.AccessExpiresAtUtc,
            TokenType: "Bearer",
            RequiresProfileCompletion: requiresProfile));
    }

    [HttpPost("register")]
    [AllowAnonymous]
    [EnableRateLimiting(SocialRateLimitPolicies.Register)]
    public async Task<ActionResult<RegisterInitResponse>> Register([FromBody] RegisterRequest request, CancellationToken ct)
    {
        var email = ResolveIdentifier(request.Email, request.Phone);
        var outcome = await _authRegistration.BeginAsync(email, request.Password ?? "", ct);
        if (!outcome.Success)
        {
            if (outcome.IsConflict)
                return Conflict(new { error = outcome.ErrorMessage });
            return BadRequest(new { error = outcome.ErrorMessage });
        }

        return Ok(new RegisterInitResponse(
            outcome.VerificationToken.ToString("D"),
            outcome.ExpiresAtUtc,
            outcome.DevVerificationCode));
    }

    [HttpPost("verify-registration")]
    [AllowAnonymous]
    [EnableRateLimiting(SocialRateLimitPolicies.Verify)]
    public async Task<ActionResult<LoginResponse>> VerifyRegistration([FromBody] VerifyRegistrationRequest request, CancellationToken ct)
    {
        if (!Guid.TryParse(request.VerificationToken, out var verificationToken))
            return BadRequest(new { error = "Некорректный токен верификации." });

        var (ip, agentHash) = GetRequestContext();
        var outcome = await _authRegistration.CompleteVerificationAsync(
            verificationToken,
            request.Code ?? "",
            new RemoteSessionHints(ip, agentHash),
            ct);

        if (!outcome.Success)
        {
            if (outcome.IsConflict)
                return Conflict(new { error = outcome.ErrorMessage });
            if (outcome.ErrorMessage == "Введите код из сообщения.")
                return BadRequest(new { error = outcome.ErrorMessage });
            return Unauthorized(new { error = outcome.ErrorMessage });
        }

        var requiresProfile = await RequiresProfileCompletionAsync(outcome.UserUuid, ct);
        return Ok(new LoginResponse(
            outcome.AccessToken!,
            outcome.RefreshToken!,
            outcome.AccessExpiresAtUtc,
            TokenType: "Bearer",
            RequiresProfileCompletion: requiresProfile));
    }

    [HttpPost("cancel-registration")]
    [AllowAnonymous]
    [EnableRateLimiting(SocialRateLimitPolicies.Register)]
    public async Task<IActionResult> CancelRegistration([FromBody] CancelRegistrationRequest request, CancellationToken ct)
    {
        if (!Guid.TryParse(request.VerificationToken, out var verificationToken))
            return Ok();

        var pending = await _auth.PendingRegistrations.FirstOrDefaultAsync(p => p.VerificationToken == verificationToken, ct);
        if (pending == null) return Ok();
        _auth.PendingRegistrations.Remove(pending);
        await _auth.SaveChangesAsync(ct);
        return Ok();
    }

    [HttpPost("refresh")]
    [AllowAnonymous]
    [EnableRateLimiting(SocialRateLimitPolicies.Refresh)]
    public async Task<ActionResult<LoginResponse>> Refresh([FromBody] RefreshRequest request, CancellationToken ct)
    {
        var outcome = await _authCredentials.RefreshAsync(request.RefreshToken ?? "", ct);
        if (!outcome.Success)
        {
            if (outcome.ErrorMessage?.Contains("required", StringComparison.OrdinalIgnoreCase) == true)
                return BadRequest(new { error = outcome.ErrorMessage });
            return Unauthorized(new { error = outcome.ErrorMessage });
        }

        var requiresProfile = await RequiresProfileCompletionAsync(outcome.UserUuid, ct);
        return Ok(new LoginResponse(
            outcome.AccessToken!,
            outcome.RefreshToken!,
            outcome.AccessExpiresAtUtc,
            TokenType: "Bearer",
            RequiresProfileCompletion: requiresProfile));
    }

    [HttpPost("logout")]
    [Authorize]
    public async Task<IActionResult> Logout(CancellationToken ct)
    {
        var jti = User.FindFirst(JwtRegisteredClaimNames.Jti)?.Value;
        if (string.IsNullOrEmpty(jti)) return Ok();

        var session = await _auth.UserSessions.FirstOrDefaultAsync(s => s.JwtId == jti, ct);
        if (session != null)
        {
            session.Status = UserSessionStatus.RevokedUser;
            await SaveAllAsync(ct);
        }

        return Ok();
    }

    /// <summary>Удаляет аккаунт текущего пользователя из базы данных. Требует повторного ввода пароля.</summary>
    [HttpPost("delete-account")]
    [Authorize]
    [EnableRateLimiting(SocialRateLimitPolicies.AccountSensitive)]
    public async Task<IActionResult> DeleteAccount([FromBody] DeleteAccountRequest? request, CancellationToken ct)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var account = await _auth.UserAccounts.FindAsync([userUuid], ct);
        if (account == null)
            return NotFound(new { error = "Аккаунт не найден." });

        // Re-authenticate before this irreversible action so a hijacked or unattended session cannot
        // delete the account without knowing the password.
        if (string.IsNullOrWhiteSpace(request?.Password) || !_passwordHasher.Verify(request.Password, account.PasswordHash))
            return BadRequest(new { error = "Неверный пароль." });

        _auth.UserAccounts.Remove(account);
        await SaveAllAsync(ct);
        return Ok(new { message = "Аккаунт удалён." });
    }

    /// <summary>Возвращает данные профиля текущего пользователя (аккаунт + user_profiles).</summary>
    [HttpGet("me")]
    [Authorize]
    public async Task<IActionResult> GetMe(CancellationToken ct)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var account = await _auth.UserAccounts.AsNoTracking().FirstOrDefaultAsync(u => u.UserUuid == userUuid, ct);
        if (account == null)
            return NotFound(new { error = "Аккаунт не найден." });
        await _presence.TouchAsync(userUuid, ct);
        var profile = await _users.UserProfiles.AsNoTracking().FirstOrDefaultAsync(p => p.UserUuid == userUuid, ct);

        // Только значение из профиля: пусто, пока пользователь не задал имя (не подставляем username — иначе веб не может показать шаг «Имя» после входа).
        var displayName = profile != null && !string.IsNullOrWhiteSpace(profile.DisplayName)
            ? profile.DisplayName.Trim()
            : "";
        var gender = profile?.Gender != null ? (int)profile.Gender.Value : (int?)null;
        var birthDate = profile?.BirthDate?.ToString("yyyy-MM-dd");
        var avatarUuid = profile?.AvatarUuid?.ToString();
        var status = profile?.Status ?? "";

        var followersCount = await _users.UserFollowers.CountAsync(f => f.FollowingUserUuid == userUuid, ct);
        var followingPeopleCount = await _users.UserFollowers.CountAsync(f => f.FollowerUserUuid == userUuid, ct);
        var ownedCommunityIds = await _content.UserCommunities.AsNoTracking().Where(uc => uc.UserUuid == userUuid && uc.Role == "Owner").Select(uc => uc.CommunityId).ToListAsync(ct);
        var followingCommunitiesCount = await _content.UserCommunities.CountAsync(uc => uc.UserUuid == userUuid && !ownedCommunityIds.Contains(uc.CommunityId) && _content.Communities.Any(c => c.CommunityId == uc.CommunityId && !c.IsPrivate), ct);
        var followingCount = followingPeopleCount + followingCommunitiesCount;

        return Ok(new
        {
            userUuid,
            username = account.Username ?? "",
            displayName,
            status,
            gender,
            birthDate,
            avatarUuid,
            phone = account.Phone ?? "",
            email = account.Email ?? "",
            followersCount,
            followingCount
        });
    }

    /// <summary>Настройки приватности текущего пользователя.</summary>
    [HttpGet("me/privacy")]
    [Authorize]
    public async Task<IActionResult> GetMyPrivacySettings(CancellationToken ct)
    {
        if (!TryGetCurrentUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var settings = await _privacySettings.GetAsync(userUuid, ct);
        return Ok(settings);
    }

    /// <summary>Обновляет настройки приватности текущего пользователя.</summary>
    [HttpPatch("me/privacy")]
    [Authorize]
    public async Task<IActionResult> UpdateMyPrivacySettings([FromBody] UpdateUserPrivacySettingsRequest request, CancellationToken ct)
    {
        if (!TryGetCurrentUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        try
        {
            var settings = await _privacySettings.UpdateAsync(userUuid, request, ct);
            return Ok(settings);
        }
        catch (ArgumentException ex)
        {
            return BadRequest(new { error = ex.Message });
        }
    }

    /// <summary>Смена пароля текущего пользователя.</summary>
    [HttpPatch("me/password")]
    [Authorize]
    [EnableRateLimiting(SocialRateLimitPolicies.AccountSensitive)]
    public async Task<IActionResult> ChangeMyPassword([FromBody] ChangePasswordRequest request, CancellationToken ct)
    {
        if (!TryGetCurrentUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var currentPassword = request.CurrentPassword ?? "";
        var newPassword = request.NewPassword ?? "";
        if (string.IsNullOrWhiteSpace(currentPassword))
            return BadRequest(new { error = "Укажите текущий пароль." });
        if (string.IsNullOrWhiteSpace(newPassword))
            return BadRequest(new { error = "Укажите новый пароль." });
        if (newPassword.Length < 8)
            return BadRequest(new { error = "Новый пароль должен быть не короче 8 символов." });

        var account = await _auth.UserAccounts.FirstOrDefaultAsync(u => u.UserUuid == userUuid, ct);
        if (account == null)
            return NotFound(new { error = "Аккаунт не найден." });
        if (!_passwordHasher.Verify(currentPassword, account.PasswordHash))
            return BadRequest(new { error = "Неверный текущий пароль." });

        account.PasswordHash = _passwordHasher.Hash(newPassword);

        var securityLog = await _auth.UserSecurityLogs.FirstOrDefaultAsync(s => s.UserUuid == userUuid, ct);
        if (securityLog == null)
        {
            securityLog = new UserSecurityLogs { UserUuid = userUuid };
            _auth.UserSecurityLogs.Add(securityLog);
        }
        securityLog.PasswordUpdatedAt = DateTime.UtcNow;
        securityLog.UpdatedAt = DateTime.UtcNow;

        var currentJti = User.FindFirst(JwtRegisteredClaimNames.Jti)?.Value ?? "";
        var now = DateTime.UtcNow;
        var sessions = await _auth.UserSessions
            .Where(s => s.UserUuid == userUuid && s.Status == UserSessionStatus.Active && s.ExpiresAt > now)
            .ToListAsync(ct);
        foreach (var session in sessions)
        {
            if (!string.IsNullOrEmpty(currentJti) && session.JwtId == currentJti)
                continue;
            session.Status = UserSessionStatus.RevokedPassword;
        }

        await SaveAllAsync(ct);
        return Ok(new { message = "Пароль изменён." });
    }

    /// <summary>Активные сессии текущего пользователя.</summary>
    [HttpGet("me/sessions")]
    [Authorize]
    public async Task<IActionResult> GetMySessions(CancellationToken ct)
    {
        if (!TryGetCurrentUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var currentJti = User.FindFirst(JwtRegisteredClaimNames.Jti)?.Value ?? "";
        var now = DateTime.UtcNow;
        var sessions = await _auth.UserSessions.AsNoTracking()
            .Where(s => s.UserUuid == userUuid && s.Status == UserSessionStatus.Active && s.ExpiresAt > now)
            .OrderByDescending(s => s.LastActivity)
            .ToListAsync(ct);

        var result = sessions.Select(s => new
        {
            sessionId = s.SessionId,
            createdAt = s.CreatedAt,
            lastActivity = s.LastActivity,
            ipAddress = s.IpAddress,
            city = s.City,
            countryCode = s.CountryCode,
            isCurrent = !string.IsNullOrEmpty(currentJti) && s.JwtId == currentJti,
        });

        return Ok(result);
    }

    /// <summary>Завершить все сессии, кроме текущей.</summary>
    [HttpDelete("me/sessions/others")]
    [Authorize]
    public async Task<IActionResult> RevokeOtherSessions(CancellationToken ct)
    {
        if (!TryGetCurrentUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var currentJti = User.FindFirst(JwtRegisteredClaimNames.Jti)?.Value ?? "";
        var now = DateTime.UtcNow;
        var sessions = await _auth.UserSessions
            .Where(s => s.UserUuid == userUuid && s.Status == UserSessionStatus.Active && s.ExpiresAt > now)
            .ToListAsync(ct);

        var revoked = 0;
        foreach (var session in sessions)
        {
            if (!string.IsNullOrEmpty(currentJti) && session.JwtId == currentJti)
                continue;
            session.Status = UserSessionStatus.RevokedUser;
            revoked++;
        }

        if (revoked > 0)
            await SaveAllAsync(ct);

        return Ok(new { revoked });
    }

    /// <summary>Сводка настроек безопасности аккаунта.</summary>
    [HttpGet("me/security")]
    [Authorize]
    public async Task<IActionResult> GetMySecurity(CancellationToken ct)
    {
        if (!TryGetCurrentUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var status = await _accountSecurity.GetStatusAsync(userUuid, ct);
        return Ok(new
        {
            twoFactorEnabled = status.TwoFactorEnabled,
            emailVerified = status.EmailVerified,
            phoneVerified = status.PhoneVerified,
        });
    }

    /// <summary>Начать смену email (код на новый адрес).</summary>
    [HttpPost("me/email/change")]
    [Authorize]
    [EnableRateLimiting(SocialRateLimitPolicies.AccountSensitive)]
    public async Task<IActionResult> BeginEmailChange([FromBody] BeginEmailChangeRequest request, CancellationToken ct)
    {
        if (!TryGetCurrentUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var outcome = await _accountSecurity.BeginEmailChangeAsync(
            userUuid,
            request.Password ?? "",
            request.NewEmail ?? "",
            ct);
        if (!outcome.Success)
        {
            if (outcome.IsConflict)
                return Conflict(new { error = outcome.ErrorMessage });
            return BadRequest(new { error = outcome.ErrorMessage });
        }

        return Ok(new
        {
            changeToken = outcome.ChangeToken,
            expiresAt = outcome.ExpiresAtUtc,
            devVerificationCode = outcome.DevVerificationCode,
        });
    }

    /// <summary>Подтвердить смену email кодом из письма.</summary>
    [HttpPost("me/email/confirm")]
    [Authorize]
    [EnableRateLimiting(SocialRateLimitPolicies.AccountSensitive)]
    public async Task<IActionResult> ConfirmEmailChange([FromBody] ConfirmEmailChangeRequest request, CancellationToken ct)
    {
        if (!TryGetCurrentUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var outcome = await _accountSecurity.ConfirmEmailChangeAsync(
            userUuid,
            request.ChangeToken ?? "",
            request.Code ?? "",
            ct);
        if (!outcome.Success)
            return BadRequest(new { error = outcome.ErrorMessage });

        return Ok(new { email = outcome.NewEmail, message = "Email обновлён." });
    }

    /// <summary>Смена номера телефона (SMS-верификация — отдельно).</summary>
    [HttpPatch("me/phone")]
    [Authorize]
    [EnableRateLimiting(SocialRateLimitPolicies.AccountSensitive)]
    public async Task<IActionResult> ChangePhone([FromBody] ChangePhoneRequest request, CancellationToken ct)
    {
        if (!TryGetCurrentUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var outcome = await _accountSecurity.ChangePhoneAsync(
            userUuid,
            request.Password ?? "",
            request.Phone ?? "",
            ct);
        if (!outcome.Success)
            return BadRequest(new { error = outcome.ErrorMessage });

        return Ok(new { message = "Номер телефона обновлён. Подтверждение по SMS будет доступно позже." });
    }

    /// <summary>Начать настройку 2FA (генерация TOTP-секрета).</summary>
    [HttpPost("me/2fa/setup")]
    [Authorize]
    [EnableRateLimiting(SocialRateLimitPolicies.AccountSensitive)]
    public async Task<IActionResult> BeginTwoFactorSetup([FromBody] TwoFactorPasswordRequest request, CancellationToken ct)
    {
        if (!TryGetCurrentUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var outcome = await _accountSecurity.BeginTwoFactorSetupAsync(userUuid, request.Password ?? "", ct);
        if (!outcome.Success)
            return BadRequest(new { error = outcome.ErrorMessage });

        return Ok(new
        {
            secret = outcome.Secret,
            otpAuthUri = outcome.OtpAuthUri,
        });
    }

    /// <summary>Включить 2FA после проверки TOTP-кода.</summary>
    [HttpPost("me/2fa/enable")]
    [Authorize]
    [EnableRateLimiting(SocialRateLimitPolicies.AccountSensitive)]
    public async Task<IActionResult> EnableTwoFactor([FromBody] TwoFactorCodeRequest request, CancellationToken ct)
    {
        if (!TryGetCurrentUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var outcome = await _accountSecurity.EnableTwoFactorAsync(userUuid, request.Code ?? "", ct);
        if (!outcome.Success)
            return BadRequest(new { error = outcome.ErrorMessage });

        return Ok(new { message = "Двухфакторная аутентификация включена." });
    }

    /// <summary>Отключить 2FA.</summary>
    [HttpDelete("me/2fa")]
    [Authorize]
    [EnableRateLimiting(SocialRateLimitPolicies.AccountSensitive)]
    public async Task<IActionResult> DisableTwoFactor([FromBody] DisableTwoFactorRequest request, CancellationToken ct)
    {
        if (!TryGetCurrentUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var outcome = await _accountSecurity.DisableTwoFactorAsync(
            userUuid,
            request.Password ?? "",
            request.Code ?? "",
            ct);
        if (!outcome.Success)
            return BadRequest(new { error = outcome.ErrorMessage });

        return Ok(new { message = "Двухфакторная аутентификация отключена." });
    }

    /// <summary>Чёрный список текущего пользователя.</summary>
    [HttpGet("me/blocks")]
    [Authorize]
    public async Task<IActionResult> GetMyBlocklist(CancellationToken ct)
    {
        if (!TryGetCurrentUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var rows = await _blocklist.ListAsync(userUuid, ct);
        if (rows.Count == 0)
            return Ok(Array.Empty<object>());

        var blockedIds = rows.Select(r => r.BlockedUserUuid).ToList();
        var accounts = await _auth.UserAccounts.AsNoTracking()
            .Where(a => blockedIds.Contains(a.UserUuid))
            .ToListAsync(ct);
        var profiles = await _users.UserProfiles.AsNoTracking()
            .Where(p => blockedIds.Contains(p.UserUuid))
            .ToListAsync(ct);
        var accBy = accounts.ToDictionary(a => a.UserUuid);
        var prBy = profiles.ToDictionary(p => p.UserUuid);

        var list = rows.Select(row =>
        {
            var acc = accBy.GetValueOrDefault(row.BlockedUserUuid);
            var prf = prBy.GetValueOrDefault(row.BlockedUserUuid);
            return new
            {
                userUuid = row.BlockedUserUuid,
                username = acc?.Username ?? "",
                displayName = prf?.DisplayName ?? acc?.Username ?? "",
                blockedAtUtc = row.BlockedAtUtc,
            };
        });
        return Ok(list);
    }

    /// <summary>Заблокировать пользователя по юзернейму.</summary>
    [HttpPost("me/blocks/{username}")]
    [Authorize]
    public async Task<IActionResult> BlockUser(string username, CancellationToken ct)
    {
        if (!TryGetCurrentUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var normalized = NormalizeUsername(username);
        if (string.IsNullOrEmpty(normalized))
            return BadRequest(new { error = "Укажите юзернейм." });

        var account = await _auth.UserAccounts.AsNoTracking()
            .FirstOrDefaultAsync(u => u.Username == normalized, ct);
        if (account is null)
            return NotFound(new { error = "Пользователь не найден." });

        try
        {
            await _blocklist.BlockAsync(userUuid, account.UserUuid, ct);
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(new { error = ex.Message });
        }

        return Ok(new { message = "Пользователь заблокирован." });
    }

    /// <summary>Разблокировать пользователя по юзернейму.</summary>
    [HttpDelete("me/blocks/{username}")]
    [Authorize]
    public async Task<IActionResult> UnblockUser(string username, CancellationToken ct)
    {
        if (!TryGetCurrentUserUuid(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var normalized = NormalizeUsername(username);
        if (string.IsNullOrEmpty(normalized))
            return BadRequest(new { error = "Укажите юзернейм." });

        var account = await _auth.UserAccounts.AsNoTracking()
            .FirstOrDefaultAsync(u => u.Username == normalized, ct);
        if (account is null)
            return NotFound(new { error = "Пользователь не найден." });

        await _blocklist.UnblockAsync(userUuid, account.UserUuid, ct);
        return NoContent();
    }

    /// <summary>Обновляет username (аккаунт) и display_name, gender, birth_date (профиль) текущего пользователя.</summary>
    [HttpPatch("profile")]
    [Authorize]
    public async Task<IActionResult> UpdateProfile([FromBody] UpdateProfileRequest request, CancellationToken ct)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var username = NormalizeUsername(request.Username);
        var displayName = (request.DisplayName ?? "").Trim();
        if (!string.IsNullOrEmpty(username))
        {
            if (!LatinIdentifiers.HasOnlyUsernameChars(request.Username))
                return BadRequest(new { error = LatinIdentifiers.UsernameFormatMessage });
            if (username.Length > 50)
                return BadRequest(new { error = "Юзернейм не более 50 символов." });
            if (IsWeakUsername(username))
                return BadRequest(new { error = "Юзернейм: минимум 2 символа, не только подчёркивания; используйте буквы или цифры." });
            if (ReservedUsernames.IsReserved(username))
                return BadRequest(new { error = ReservedUsernames.ReservedMessage });
        }
        if (!string.IsNullOrEmpty(displayName) && displayName.Length > 100)
            return BadRequest(new { error = "Имя не более 100 символов." });

        if (request.Gender.HasValue && request.Gender.Value != (int)UserGender.Male && request.Gender.Value != (int)UserGender.Female)
            return BadRequest(new { error = "Пол: укажите 0 (мужской) или 1 (женский)." });
        if (request.Status != null && request.Status.Length > 150)
            return BadRequest(new { error = "Статус не более 150 символов." });

        DateOnly? birthDate = null;
        if (!string.IsNullOrWhiteSpace(request.BirthDate))
        {
            if (!DateOnly.TryParse(request.BirthDate, out var parsed))
                return BadRequest(new { error = "Неверный формат даты рождения (ожидается ГГГГ-ММ-ДД)." });
            var today = DateOnly.FromDateTime(DateTime.UtcNow);
            if (parsed > today)
                return BadRequest(new { error = "Дата рождения не может быть в будущем." });
            if (parsed.Year < 1900)
                return BadRequest(new { error = "Укажите год рождения не ранее 1900." });
            birthDate = parsed;
        }

        var account = await _auth.UserAccounts.FindAsync([userUuid], ct);
        if (account == null)
            return NotFound(new { error = "Аккаунт не найден." });

        if (!string.IsNullOrEmpty(username))
        {
            if (await _auth.UserAccounts.AnyAsync(u => u.UserUuid != userUuid && u.Username == username, ct))
                return Conflict(new { error = "Этот юзернейм уже занят." });
            account.Username = username;
            account.UpdatedAt = DateTime.UtcNow;
        }

        var profile = await _users.UserProfiles.FindAsync([userUuid], ct);
        if (profile == null)
        {
            profile = new UserProfile
            {
                UserUuid = userUuid,
                DisplayName = displayName.Length > 0 ? displayName : account.Username ?? "",
                Gender = request.Gender.HasValue ? (UserGender)request.Gender.Value : null,
                BirthDate = birthDate,
                Status = request.Status != null && request.Status.Length <= 150 ? request.Status : null
            };
            _users.UserProfiles.Add(profile);
        }
        else
        {
            if (displayName.Length > 0) profile.DisplayName = displayName;
            if (request.Gender.HasValue) profile.Gender = (UserGender)request.Gender.Value;
            if (request.BirthDate != null) profile.BirthDate = birthDate;
            if (request.Status != null) profile.Status = request.Status.Length > 150 ? request.Status[..150] : request.Status;
            profile.UpdatedAt = DateTime.UtcNow;
        }

        await SaveAllAsync(ct);
        return Ok(new { message = "Профиль обновлён." });
    }

    private static readonly string[] AllowedAvatarTypes = { "image/jpeg", "image/png", "image/webp" };
    private const int MaxAvatarSizeBytes = 2 * 1024 * 1024; // 2 MB

    /// <summary>Загрузить аватар текущего пользователя. Multipart: файл в поле "file".</summary>
    [HttpPost("profile/avatar")]
    [Authorize]
    [EnableRateLimiting(SocialRateLimitPolicies.Upload)]
    public async Task<IActionResult> UploadAvatar(IFormFile? file, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        if (file == null || file.Length == 0)
            return BadRequest(new { error = "Выберите файл изображения (JPEG, PNG или WebP, до 2 МБ)." });
        if (file.Length > MaxAvatarSizeBytes)
            return BadRequest(new { error = "Файл не должен превышать 2 МБ." });
        var contentType = file.ContentType?.Split(';')[0].Trim() ?? "";
        if (!AllowedAvatarTypes.Contains(contentType, StringComparer.OrdinalIgnoreCase))
            return BadRequest(new { error = "Допустимые форматы: JPEG, PNG, WebP." });
        byte[] data;
        string storedContentType;
        try
        {
            using var stream = file.OpenReadStream();
            (data, storedContentType) = await PostImageProcessor.ProcessAsync(stream, ct);
        }
        catch (Exception ex) when (ex is UnknownImageFormatException or InvalidImageContentException or InvalidOperationException)
        {
            return BadRequest(new { error = "Файл не является корректным изображением (JPEG, PNG или WebP)." });
        }
        var avatar = new UserAvatar
        {
            Uuid = FloraUuid.NewGuid(),
            UserUuid = userUuid,
            ContentType = storedContentType,
            Data = data
        };
        _users.UserAvatars.Add(avatar);
        var profile = await _users.UserProfiles.FindAsync([userUuid], ct);
        if (profile == null)
        {
            profile = new UserProfile { UserUuid = userUuid, DisplayName = "" };
            _users.UserProfiles.Add(profile);
        }
        profile.AvatarUuid = avatar.Uuid;
        profile.UpdatedAt = DateTime.UtcNow;
        await SaveAllAsync(ct);
        return Ok(new { avatarUuid = avatar.Uuid.ToString() });
    }

    /// <summary>Удалить аватар текущего пользователя (сброс avatar_uuid в профиле).</summary>
    [HttpDelete("profile/avatar")]
    [Authorize]
    public async Task<IActionResult> DeleteAvatar(CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var profile = await _users.UserProfiles.FindAsync([userUuid], ct);
        if (profile != null && profile.AvatarUuid != null)
        {
            profile.AvatarUuid = null;
            profile.UpdatedAt = DateTime.UtcNow;
            await SaveAllAsync(ct);
        }

        return Ok(new { message = "Аватар удалён." });
    }

    /// <summary>Получить изображение аватара по UUID (пользователь или сообщество, публичный доступ).</summary>
    [HttpGet("avatar/{uuid:guid}")]
    [AllowAnonymous]
    public async Task<IActionResult> GetAvatar(Guid uuid, CancellationToken ct = default)
    {
        var userAvatar = await _users.UserAvatars.AsNoTracking()
            .FirstOrDefaultAsync(a => a.Uuid == uuid, ct);
        if (userAvatar != null && userAvatar.Data.Length > 0)
            return File(userAvatar.Data, userAvatar.ContentType);
        var communityAvatar = await _content.CommunityAvatars.AsNoTracking()
            .FirstOrDefaultAsync(a => a.Uuid == uuid, ct);
        if (communityAvatar != null && communityAvatar.Data.Length > 0)
            return File(communityAvatar.Data, communityAvatar.ContentType);
        return NotFound();
    }

    /// <summary>Публичный профиль по юзернейму (счётчики подписчиков, посты не включены).</summary>
    [HttpGet("profile/{username}")]
    [AllowAnonymous]
    public async Task<IActionResult> GetProfileByUsername(string username, CancellationToken ct)
    {
        var normalized = NormalizeUsername(username);
        if (string.IsNullOrEmpty(normalized))
            return BadRequest(new { error = "Укажите юзернейм." });
        var account = await FindUserAccountByUsernameAsync(normalized, ct);
        if (account == null)
            return NotFound(new { error = "Пользователь не найден." });
        var profile = await _users.UserProfiles.AsNoTracking().FirstOrDefaultAsync(p => p.UserUuid == account.UserUuid, ct);
        var followersCount = await _users.UserFollowers.CountAsync(f => f.FollowingUserUuid == account.UserUuid, ct);
        var followingPeopleCount = await _users.UserFollowers.CountAsync(f => f.FollowerUserUuid == account.UserUuid, ct);
        var ownedCommunityIds = await _content.UserCommunities.AsNoTracking().Where(uc => uc.UserUuid == account.UserUuid && uc.Role == "Owner").Select(uc => uc.CommunityId).ToListAsync(ct);
        var followingCommunitiesCount = await _content.UserCommunities.CountAsync(uc => uc.UserUuid == account.UserUuid && !ownedCommunityIds.Contains(uc.CommunityId) && _content.Communities.Any(c => c.CommunityId == uc.CommunityId && !c.IsPrivate), ct);
        var followingCount = followingPeopleCount + followingCommunitiesCount;
        var isFollowingByMe = false;
        var canMessageByMe = false;
        if (TryGetCurrentUserUuid(out var profileViewerUuid) && profileViewerUuid != account.UserUuid)
        {
            isFollowingByMe = await _followGraph.IsFollowingAsync(profileViewerUuid, account.UserUuid, ct);
            canMessageByMe = await _profileAccess.CanAccessAsync(
                profileViewerUuid, account.UserUuid, ProfileAccessField.Messages, ct);
        }
        return Ok(new
        {
            userUuid = account.UserUuid,
            username = account.Username ?? "",
            displayName = profile?.DisplayName ?? account.Username ?? "",
            status = profile?.Status ?? "",
            avatarUuid = profile?.AvatarUuid?.ToString(),
            followersCount,
            followingCount,
            isFollowingByMe,
            canMessageByMe,
        });
    }

    /// <summary>
    /// Лента: по умолчанию <c>kind=recommendations</c> (гибрид: подписки + engagement + recency);
    /// <c>kind=subscriptions</c> — только посты от подписок, по дате (новые сверху).
    /// <paramref name="refresh"/> = true на рекомендациях пересобирает per-user snapshot (не идемпотентен по ответу).
    /// </summary>
    [HttpGet("feed")]
    [Authorize]
    public async Task<IActionResult> GetFeed(
        [FromQuery] int take = 20,
        [FromQuery] string? cursor = null,
        [FromQuery] string? kind = null,
        [FromQuery] bool refresh = false,
        CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        take = Math.Clamp(take, 1, 50);
        var isSubscriptions = string.Equals(kind, "subscriptions", StringComparison.OrdinalIgnoreCase);
        var page = isSubscriptions
            ? await _feedRecommendation.GetSubscriptionsFeedAsync(userUuid, take, cursor, ct)
            : await _feedRecommendation.GetRecommendedFeedAsync(userUuid, take, cursor, forceRefresh: refresh, ct);
        return await SerializeFeedPageAsync(userUuid, page, ct);
    }

    /// <summary>
    /// Лёгкая проверка наличия нового контента (§13.4 FIRA.md).
    /// Клиент поллит раз в 30 с, передавая generatedAt из последнего ответа GetFeed.
    /// При hasNew = true показывает баннер «Новые посты» без сброса скролла.
    /// </summary>
    [HttpGet("feed/has-new")]
    [Authorize]
    public async Task<IActionResult> FeedHasNew(
        [FromQuery] DateTime? since,
        CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        if (since is null || since.Value == default)
            return BadRequest(new { error = "Параметр 'since' обязателен (ISO 8601 UTC)." });

        var hasNew = await _feedRecommendation.HasNewContentAsync(userUuid, since.Value, ct);
        return Ok(new { hasNew, checkedAt = DateTime.UtcNow });
    }

    private async Task<IActionResult> SerializeFeedPageAsync(Guid userUuid, FeedPage page, CancellationToken ct)
    {
        if (page.PostUuids.Count == 0)
            return Ok(new { items = Array.Empty<object>(), nextCursor = page.NextCursor, hasMore = page.HasMore, generatedAt = page.GeneratedAt, expiresAt = page.ExpiresAt });

        var postUuids = page.PostUuids.ToList();
        var posts = await _content.UserPosts.AsNoTracking()
            .Where(p => postUuids.Contains(p.PostUuid) && !p.IsDeleted)
            .Select(p => new { p.PostUuid, p.Content, p.CreatedAt, p.AuthorUserUuid, p.CommunityId })
            .ToListAsync(ct);
        var orderDict = postUuids.Select((id, i) => (id, i)).ToDictionary(x => x.id, x => x.i);
        var orderedPosts = posts.OrderBy(p => orderDict.GetValueOrDefault(p.PostUuid, int.MaxValue)).ToList();

        var authorUuids = orderedPosts.Select(p => p.AuthorUserUuid).Distinct().ToList();
        var accounts = await _auth.UserAccounts.AsNoTracking().Where(a => authorUuids.Contains(a.UserUuid)).Select(a => new { a.UserUuid, a.Username }).ToListAsync(ct);
        var profiles = await _users.UserProfiles.AsNoTracking().Where(p => authorUuids.Contains(p.UserUuid)).Select(p => new { p.UserUuid, p.DisplayName, p.AvatarUuid }).ToListAsync(ct);
        var accountByUuid = accounts.ToDictionary(a => a.UserUuid);
        var profileByUuid = profiles.ToDictionary(p => p.UserUuid);

        var communityIds = orderedPosts.Where(p => p.CommunityId.HasValue).Select(p => p.CommunityId!.Value).Distinct().ToList();
        var communityByUuid = new Dictionary<Guid, (string Name, string Slug, Guid? AvatarUuid)>();
        if (communityIds.Count > 0)
        {
            var communityList = await _content.Communities.AsNoTracking().Where(c => communityIds.Contains(c.CommunityId)).Select(c => new { c.CommunityId, c.Name, c.Slug, c.AvatarUuid }).ToListAsync(ct);
            foreach (var c in communityList)
                communityByUuid[c.CommunityId] = (c.Name ?? "", c.Slug ?? "", c.AvatarUuid);
        }

        var commentCounts = await _content.PostComments.AsNoTracking().Where(c => postUuids.Contains(c.PostUuid) && !c.IsDeleted).GroupBy(c => c.PostUuid).Select(g => new { PostUuid = g.Key, Count = g.Count() }).ToListAsync(ct);
        var likeCounts = await _content.PostLikes.AsNoTracking().Where(l => postUuids.Contains(l.PostUuid)).GroupBy(l => l.PostUuid).Select(g => new { PostUuid = g.Key, Count = g.Count() }).ToListAsync(ct);
        var repostCounts = await _content.PostReposts.AsNoTracking().Where(r => postUuids.Contains(r.PostUuid)).GroupBy(r => r.PostUuid).Select(g => new { PostUuid = g.Key, Count = g.Count() }).ToListAsync(ct);
        var viewCounts = await _content.PostViews.AsNoTracking().Where(v => postUuids.Contains(v.PostUuid)).GroupBy(v => v.PostUuid).Select(g => new { PostUuid = g.Key, Count = g.Count() }).ToListAsync(ct);
        var commentDict = commentCounts.ToDictionary(x => x.PostUuid, x => x.Count);
        var likeDict = likeCounts.ToDictionary(x => x.PostUuid, x => x.Count);
        var repostDict = repostCounts.ToDictionary(x => x.PostUuid, x => x.Count);
        var viewDict = viewCounts.ToDictionary(x => x.PostUuid, x => x.Count);

        var likedPostIds = (await _content.PostLikes.AsNoTracking().Where(l => l.UserUuid == userUuid && postUuids.Contains(l.PostUuid)).Select(l => l.PostUuid).ToListAsync(ct)).ToHashSet();
        var repostedPostIds = (await _content.PostReposts.AsNoTracking().Where(r => r.UserUuid == userUuid && postUuids.Contains(r.PostUuid)).Select(r => r.PostUuid).ToListAsync(ct)).ToHashSet();
        var commentedPostIds = (await _content.PostComments.AsNoTracking().Where(c => c.AuthorUserUuid == userUuid && postUuids.Contains(c.PostUuid) && !c.IsDeleted).Select(c => c.PostUuid).Distinct().ToListAsync(ct)).ToHashSet();

        var postImages = await _content.PostImages.AsNoTracking().Where(i => postUuids.Contains(i.PostUuid)).OrderBy(i => i.PostUuid).ThenBy(i => i.SortOrder).Select(i => new { i.PostUuid, i.Uuid }).ToListAsync(ct);
        var imagesByPost = postImages.GroupBy(i => i.PostUuid).ToDictionary(g => g.Key, g => g.Select(x => x.Uuid).ToList());
        var videosByPost = await GetPostVideosByPostAsync(postUuids, ct);

        var followingIds = (await _followGraph.GetFollowingUserIdsAsync(userUuid, ct)).ToHashSet();
        followingIds.Remove(userUuid);
        var followedRepostersByPost = followingIds.Count > 0
            ? await _feedQueries.GetFollowedReposterIdsByPostsAsync(postUuids, followingIds, ct)
            : new Dictionary<Guid, IReadOnlyList<Guid>>();

        var reposterUuids = followedRepostersByPost.Values
            .SelectMany(ids => ids)
            .Distinct()
            .ToList();
        var reposterAccounts = reposterUuids.Count > 0
            ? await _auth.UserAccounts.AsNoTracking()
                .Where(a => reposterUuids.Contains(a.UserUuid))
                .Select(a => new { a.UserUuid, a.Username })
                .ToListAsync(ct)
            : [];
        var reposterProfiles = reposterUuids.Count > 0
            ? await _users.UserProfiles.AsNoTracking()
                .Where(p => reposterUuids.Contains(p.UserUuid))
                .Select(p => new { p.UserUuid, p.DisplayName })
                .ToListAsync(ct)
            : [];
        var reposterAccountByUuid = reposterAccounts.ToDictionary(a => a.UserUuid);
        var reposterProfileByUuid = reposterProfiles.ToDictionary(p => p.UserUuid);

        var items = orderedPosts.Select(p =>
        {
            var acc = accountByUuid.GetValueOrDefault(p.AuthorUserUuid);
            var prf = profileByUuid.GetValueOrDefault(p.AuthorUserUuid);
            (string? cn, string? cs, Guid? cav) comm = (null, null, null);
            if (p.CommunityId.HasValue && communityByUuid.TryGetValue(p.CommunityId.Value, out var c))
                comm = (c.Name, c.Slug, c.AvatarUuid);

            var followedRepostItems = new List<object>();
            foreach (var reposterUuid in followedRepostersByPost.GetValueOrDefault(p.PostUuid, Array.Empty<Guid>()))
            {
                var reposterAcc = reposterAccountByUuid.GetValueOrDefault(reposterUuid);
                var reposterPrf = reposterProfileByUuid.GetValueOrDefault(reposterUuid);
                var username = reposterAcc?.Username ?? "";
                if (string.IsNullOrWhiteSpace(username)) continue;
                followedRepostItems.Add(new
                {
                    username,
                    displayName = reposterPrf?.DisplayName ?? username,
                });
            }

            return new
            {
                postUuid = p.PostUuid,
                content = p.Content,
                createdAt = p.CreatedAt,
                authorUserUuid = p.AuthorUserUuid,
                authorUsername = acc?.Username ?? "",
                authorDisplayName = prf?.DisplayName ?? acc?.Username ?? "",
                authorAvatarUuid = prf?.AvatarUuid?.ToString(),
                communityId = p.CommunityId,
                communityName = comm.cn,
                communitySlug = comm.cs,
                communityAvatarUuid = comm.cav?.ToString(),
                imageUuids = imagesByPost.GetValueOrDefault(p.PostUuid, new List<Guid>()),
                video = videosByPost.GetValueOrDefault(p.PostUuid),
                commentsCount = commentDict.GetValueOrDefault(p.PostUuid, 0),
                likesCount = likeDict.GetValueOrDefault(p.PostUuid, 0),
                repostsCount = repostDict.GetValueOrDefault(p.PostUuid, 0),
                viewsCount = viewDict.GetValueOrDefault(p.PostUuid, 0),
                liked = likedPostIds.Contains(p.PostUuid),
                reposted = repostedPostIds.Contains(p.PostUuid),
                hasCommented = commentedPostIds.Contains(p.PostUuid),
                followedReposts = followedRepostItems.Count > 0 ? followedRepostItems : null,
            };
        });

        return Ok(new { items, nextCursor = page.NextCursor, hasMore = page.HasMore, generatedAt = page.GeneratedAt, expiresAt = page.ExpiresAt });
    }

    /// <summary>Посты пользователя по юзернейму (последние первые), с количеством комментариев, лайков, репостов и флагами liked/reposted для текущего пользователя.</summary>
    [HttpGet("profile/{username}/posts")]
    [AllowAnonymous]
    public async Task<IActionResult> GetPosts(string username, [FromQuery] int skip = 0, [FromQuery] int take = 20, CancellationToken ct = default)
    {
        var normalized = NormalizeUsername(username);
        if (string.IsNullOrEmpty(normalized))
            return BadRequest(new { error = "Укажите юзернейм." });
        var account = await _auth.UserAccounts.AsNoTracking().FirstOrDefaultAsync(u => u.Username == normalized, ct);
        if (account == null)
            return NotFound(new { error = "Пользователь не найден." });
        TryGetCurrentUserUuid(out var viewerUuid);
        if (!await _profileAccess.CanAccessAsync(viewerUuid, account.UserUuid, ProfileAccessField.Posts, ct))
            return Ok(Array.Empty<object>());
        take = Math.Clamp(take, 1, 50);
        var posts = await _content.UserPosts.AsNoTracking()
            .Where(p => p.AuthorUserUuid == account.UserUuid && !p.IsDeleted && p.CommunityId == null)
            .OrderByDescending(p => p.CreatedAt)
            .Skip(skip).Take(take)
            .Select(p => new { postUuid = p.PostUuid, content = p.Content, createdAt = p.CreatedAt })
            .ToListAsync(ct);
        if (posts.Count == 0)
            return Ok(posts);
        var postUuids = posts.Select(p => p.postUuid).ToList();
        var commentCounts = await _content.PostComments.AsNoTracking()
            .Where(c => postUuids.Contains(c.PostUuid) && !c.IsDeleted)
            .GroupBy(c => c.PostUuid)
            .Select(g => new { PostUuid = g.Key, Count = g.Count() })
            .ToListAsync(ct);
        var likeCounts = await _content.PostLikes.AsNoTracking()
            .Where(l => postUuids.Contains(l.PostUuid))
            .GroupBy(l => l.PostUuid)
            .Select(g => new { PostUuid = g.Key, Count = g.Count() })
            .ToListAsync(ct);
        var repostCounts = await _content.PostReposts.AsNoTracking()
            .Where(r => postUuids.Contains(r.PostUuid))
            .GroupBy(r => r.PostUuid)
            .Select(g => new { PostUuid = g.Key, Count = g.Count() })
            .ToListAsync(ct);
        var viewCounts = await _content.PostViews.AsNoTracking()
            .Where(v => postUuids.Contains(v.PostUuid))
            .GroupBy(v => v.PostUuid)
            .Select(g => new { PostUuid = g.Key, Count = g.Count() })
            .ToListAsync(ct);
        var commentDict = commentCounts.ToDictionary(x => x.PostUuid, x => x.Count);
        var likeDict = likeCounts.ToDictionary(x => x.PostUuid, x => x.Count);
        var repostDict = repostCounts.ToDictionary(x => x.PostUuid, x => x.Count);
        var viewDict = viewCounts.ToDictionary(x => x.PostUuid, x => x.Count);
        Guid? currentUserUuid = null;
        if (User.Identity?.IsAuthenticated == true && Guid.TryParse(User.FindFirst(ClaimTypes.NameIdentifier)?.Value, out var uid))
            currentUserUuid = uid;
        HashSet<Guid>? likedPostIds = null;
        HashSet<Guid>? repostedPostIds = null;
        HashSet<Guid>? commentedPostIds = null;
        if (currentUserUuid.HasValue)
        {
            likedPostIds = (await _content.PostLikes.AsNoTracking()
                .Where(l => l.UserUuid == currentUserUuid && postUuids.Contains(l.PostUuid))
                .Select(l => l.PostUuid)
                .ToListAsync(ct)).ToHashSet();
            repostedPostIds = (await _content.PostReposts.AsNoTracking()
                .Where(r => r.UserUuid == currentUserUuid && postUuids.Contains(r.PostUuid))
                .Select(r => r.PostUuid)
                .ToListAsync(ct)).ToHashSet();
            commentedPostIds = (await _content.PostComments.AsNoTracking()
                .Where(c => c.AuthorUserUuid == currentUserUuid && postUuids.Contains(c.PostUuid) && !c.IsDeleted)
                .Select(c => c.PostUuid)
                .Distinct()
                .ToListAsync(ct)).ToHashSet();
        }
        var postImagesProfile = await _content.PostImages.AsNoTracking().Where(i => postUuids.Contains(i.PostUuid)).OrderBy(i => i.PostUuid).ThenBy(i => i.SortOrder).Select(i => new { i.PostUuid, i.Uuid }).ToListAsync(ct);
        var imagesByPostProfile = postImagesProfile.GroupBy(i => i.PostUuid).ToDictionary(g => g.Key, g => g.Select(x => x.Uuid).ToList());
        var videosByPostProfile = await GetPostVideosByPostAsync(postUuids, ct);
        var result = posts.Select(p => new
        {
            p.postUuid,
            p.content,
            p.createdAt,
            imageUuids = imagesByPostProfile.GetValueOrDefault(p.postUuid, new List<Guid>()),
            video = videosByPostProfile.GetValueOrDefault(p.postUuid),
            commentsCount = commentDict.GetValueOrDefault(p.postUuid, 0),
            likesCount = likeDict.GetValueOrDefault(p.postUuid, 0),
            repostsCount = repostDict.GetValueOrDefault(p.postUuid, 0),
            viewsCount = viewDict.GetValueOrDefault(p.postUuid, 0),
            liked = likedPostIds?.Contains(p.postUuid) ?? false,
            reposted = repostedPostIds?.Contains(p.postUuid) ?? false,
            hasCommented = commentedPostIds?.Contains(p.postUuid) ?? false
        });
        return Ok(result);
    }

    /// <summary>Посты, которые пользователь лайкнул (с учётом приватности).</summary>
    [HttpGet("profile/{username}/likes")]
    [AllowAnonymous]
    public async Task<IActionResult> GetLikedPosts(string username, [FromQuery] int skip = 0, [FromQuery] int take = 20, CancellationToken ct = default)
    {
        var ownerUserUuid = await ResolveProfileUserUuidAsync(username, ct);
        if (!ownerUserUuid.HasValue)
            return NotFound(new { error = "Пользователь не найден." });
        Guid? viewerUuid = TryGetCurrentUserUuid(out var uid) ? uid : null;
        if (!await _profileAccess.CanAccessAsync(viewerUuid, ownerUserUuid.Value, ProfileAccessField.Likes, ct))
            return Ok(Array.Empty<object>());
        take = Math.Clamp(take, 1, 50);
        var posts = await (
            from like in _content.PostLikes.AsNoTracking()
            join post in _content.UserPosts.AsNoTracking() on like.PostUuid equals post.PostUuid
            where like.UserUuid == ownerUserUuid.Value && !post.IsDeleted && post.CommunityId == null
            orderby like.CreatedAt descending
            select new ProfilePostRow(post.PostUuid, post.Content, post.CreatedAt)
        ).Skip(skip).Take(take).ToListAsync(ct);
        return await BuildProfilePostsPayloadAsync(posts, viewerUuid, ct);
    }

    /// <summary>Посты, которые пользователь репостнул (с учётом приватности).</summary>
    [HttpGet("profile/{username}/reposts")]
    [AllowAnonymous]
    public async Task<IActionResult> GetRepostedPosts(string username, [FromQuery] int skip = 0, [FromQuery] int take = 20, CancellationToken ct = default)
    {
        var ownerUserUuid = await ResolveProfileUserUuidAsync(username, ct);
        if (!ownerUserUuid.HasValue)
            return NotFound(new { error = "Пользователь не найден." });
        Guid? viewerUuid = TryGetCurrentUserUuid(out var uid) ? uid : null;
        if (!await _profileAccess.CanAccessAsync(viewerUuid, ownerUserUuid.Value, ProfileAccessField.Reposts, ct))
            return Ok(Array.Empty<object>());
        take = Math.Clamp(take, 1, 50);
        var posts = await (
            from repost in _content.PostReposts.AsNoTracking()
            join post in _content.UserPosts.AsNoTracking() on repost.PostUuid equals post.PostUuid
            where repost.UserUuid == ownerUserUuid.Value && !post.IsDeleted && post.CommunityId == null
            orderby repost.CreatedAt descending
            select new ProfilePostRow(post.PostUuid, post.Content, post.CreatedAt)
        ).Skip(skip).Take(take).ToListAsync(ct);
        return await BuildProfilePostsPayloadAsync(posts, viewerUuid, ct);
    }

    /// <summary>Удалить пост (только автор).</summary>
    [HttpDelete("posts/{postUuid:guid}")]
    [Authorize]
    public async Task<IActionResult> DeletePost(Guid postUuid, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var post = await _content.UserPosts.FirstOrDefaultAsync(p => p.PostUuid == postUuid, ct);
        if (post == null)
            return NotFound(new { error = "Пост не найден." });
        if (post.AuthorUserUuid != userUuid)
            return Forbid();
        if (post.IsDeleted)
            return NoContent();
        post.IsDeleted = true;
        post.DeletedAt = DateTime.UtcNow;
        await SaveAllAsync(ct);
        _feedRecommendation.InvalidateFeedCache(userUuid);
        return NoContent();
    }

    /// <summary>Создать пост от имени текущего пользователя (на стене или в сообществе).</summary>
    [HttpPost("posts")]
    [Authorize]
    [EnableRateLimiting(SocialRateLimitPolicies.Write)]
    public async Task<IActionResult> CreatePost([FromBody] CreatePostRequest request, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var content = (request.Content ?? "").Trim();
        if (content.Length > MaxPostContentLength)
            return BadRequest(new { error = $"Пост не более {MaxPostContentLength} символов." });
        Guid? communityId = request.CommunityId;
        if (communityId.HasValue)
        {
            var isOwner = await _content.UserCommunities.AsNoTracking()
                .AnyAsync(uc => uc.CommunityId == communityId.Value && uc.UserUuid == userUuid && uc.Role == "Owner", ct);
            if (!isOwner)
                return Forbid();
        }
        var post = new UserPost { AuthorUserUuid = userUuid, Content = content, CommunityId = communityId };
        _content.UserPosts.Add(post);
        await SaveAllAsync(ct);
        _feedRecommendation.InvalidateFeedCache(userUuid);
        return Ok(new { postUuid = post.PostUuid, content = post.Content, createdAt = post.CreatedAt });
    }

    private const int MaxPostContentLength = 2000;
    private const int MaxPostDraftsPerUser = 15;
    private const int MaxPostDraftLabelLen = 50;

    /// <summary>Черновики постов текущего пользователя (стена или сообщество).</summary>
    [HttpGet("post-drafts")]
    [Authorize]
    public async Task<IActionResult> ListPostDrafts([FromQuery] Guid? communityId, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var query = _content.PostDrafts.AsNoTracking().Where(d => d.AuthorUserUuid == userUuid);
        query = communityId.HasValue
            ? query.Where(d => d.CommunityId == communityId.Value)
            : query.Where(d => d.CommunityId == null);

        var drafts = await query
            .OrderByDescending(d => d.UpdatedAt)
            .ThenByDescending(d => d.CreatedAt)
            .Select(d => new
            {
                draftUuid = d.DraftUuid,
                label = d.Label,
                content = d.Content,
                communityId = d.CommunityId,
                createdAt = d.CreatedAt,
                updatedAt = d.UpdatedAt,
            })
            .ToListAsync(ct);

        return Ok(drafts);
    }

    /// <summary>Создать черновик поста.</summary>
    [HttpPost("post-drafts")]
    [Authorize]
    [EnableRateLimiting(SocialRateLimitPolicies.Write)]
    public async Task<IActionResult> CreatePostDraft([FromBody] CreatePostDraftRequest request, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var content = request.Content ?? "";
        if (content.Length > MaxPostContentLength)
            return BadRequest(new { error = $"Черновик не более {MaxPostContentLength} символов." });

        Guid? communityId = request.CommunityId;
        if (communityId.HasValue)
        {
            var isOwner = await _content.UserCommunities.AsNoTracking()
                .AnyAsync(uc => uc.CommunityId == communityId.Value && uc.UserUuid == userUuid && uc.Role == "Owner", ct);
            if (!isOwner)
                return Forbid();
        }

        var scopeQuery = _content.PostDrafts.AsNoTracking().Where(d => d.AuthorUserUuid == userUuid);
        scopeQuery = communityId.HasValue
            ? scopeQuery.Where(d => d.CommunityId == communityId.Value)
            : scopeQuery.Where(d => d.CommunityId == null);
        var existingCount = await scopeQuery.CountAsync(ct);
        if (existingCount >= MaxPostDraftsPerUser)
            return BadRequest(new { error = $"Не более {MaxPostDraftsPerUser} черновиков." });

        var label = NormalizePostDraftLabel(request.Label, existingCount + 1);
        var now = DateTime.UtcNow;
        var draft = new PostDraft
        {
            AuthorUserUuid = userUuid,
            CommunityId = communityId,
            Label = label,
            Content = content,
            CreatedAt = now,
            UpdatedAt = now,
        };
        _content.PostDrafts.Add(draft);
        await SaveAllAsync(ct);
        return Ok(new
        {
            draftUuid = draft.DraftUuid,
            label = draft.Label,
            content = draft.Content,
            communityId = draft.CommunityId,
            createdAt = draft.CreatedAt,
            updatedAt = draft.UpdatedAt,
        });
    }

    /// <summary>Обновить черновик (название и/или текст).</summary>
    [HttpPatch("post-drafts/{draftUuid:guid}")]
    [Authorize]
    public async Task<IActionResult> UpdatePostDraft(Guid draftUuid, [FromBody] UpdatePostDraftRequest request, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var draft = await _content.PostDrafts.FirstOrDefaultAsync(d => d.DraftUuid == draftUuid, ct);
        if (draft == null)
            return NotFound(new { error = "Черновик не найден." });
        if (draft.AuthorUserUuid != userUuid)
            return Forbid();

        if (request.Label is not null)
        {
            var trimmed = request.Label.Trim();
            if (trimmed.Length == 0)
                return BadRequest(new { error = "Название черновика не может быть пустым." });
            draft.Label = trimmed.Length <= MaxPostDraftLabelLen ? trimmed : trimmed[..MaxPostDraftLabelLen];
        }

        if (request.Content is not null)
        {
            if (request.Content.Length > MaxPostContentLength)
                return BadRequest(new { error = $"Черновик не более {MaxPostContentLength} символов." });
            draft.Content = request.Content;
        }

        draft.UpdatedAt = DateTime.UtcNow;
        await SaveAllAsync(ct);
        return Ok(new
        {
            draftUuid = draft.DraftUuid,
            label = draft.Label,
            content = draft.Content,
            communityId = draft.CommunityId,
            createdAt = draft.CreatedAt,
            updatedAt = draft.UpdatedAt,
        });
    }

    /// <summary>Удалить черновик.</summary>
    [HttpDelete("post-drafts/{draftUuid:guid}")]
    [Authorize]
    public async Task<IActionResult> DeletePostDraft(Guid draftUuid, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var draft = await _content.PostDrafts.FirstOrDefaultAsync(d => d.DraftUuid == draftUuid, ct);
        if (draft == null)
            return NotFound(new { error = "Черновик не найден." });
        if (draft.AuthorUserUuid != userUuid)
            return Forbid();

        _content.PostDrafts.Remove(draft);
        await SaveAllAsync(ct);
        return NoContent();
    }

    private static string NormalizePostDraftLabel(string? label, int fallbackIndex)
    {
        var trimmed = (label ?? "").Trim();
        if (trimmed.Length == 0)
            return $"Черновик {fallbackIndex}";
        return trimmed.Length <= MaxPostDraftLabelLen ? trimmed : trimmed[..MaxPostDraftLabelLen];
    }

    private static readonly string[] AllowedPostImageTypes = { "image/jpeg", "image/png", "image/webp" };
    private const int MaxPostImageSizeBytes = 5 * 1024 * 1024; // 5 MB per image
    private const int MaxPostImagesCount = 10;

    /// <summary>Загрузить фото к посту. Multipart: файлы в поле "files". Только автор поста. Макс. 10 фото, до 5 МБ каждое.</summary>
    [HttpPost("posts/{postUuid:guid}/images")]
    [Authorize]
    [EnableRateLimiting(SocialRateLimitPolicies.Upload)]
    [RequestSizeLimit(MaxPostImageSizeBytes * MaxPostImagesCount + 4 * 1024 * 1024)]
    public async Task<IActionResult> UploadPostImages(Guid postUuid, [FromForm] IFormFileCollection? files, CancellationToken ct = default)
    {
        try
        {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var post = await _content.UserPosts.AsNoTracking().FirstOrDefaultAsync(p => p.PostUuid == postUuid && !p.IsDeleted, ct);
        if (post == null)
            return NotFound(new { error = "Пост не найден." });
        if (post.AuthorUserUuid != userUuid)
            return Forbid();
        if (files == null || files.Count == 0)
            return BadRequest(new { error = "Выберите хотя бы один файл (JPEG, PNG или WebP, до 5 МБ)." });
        if (files.Count > MaxPostImagesCount)
            return BadRequest(new { error = $"Не более {MaxPostImagesCount} фото за раз." });
        var existingCount = await _content.PostImages.CountAsync(i => i.PostUuid == postUuid, ct);
        if (existingCount + files.Count > MaxPostImagesCount)
            return BadRequest(new { error = $"В посте не более {MaxPostImagesCount} фото." });
        var uploaded = new List<Guid>();
        for (var i = 0; i < files.Count; i++)
        {
            var file = files[i];
            if (file == null || file.Length == 0) continue;
            if (file.Length > MaxPostImageSizeBytes)
                return BadRequest(new { error = "Каждый файл не более 5 МБ." });
            var contentType = file.ContentType?.Split(';')[0].Trim() ?? "";
            if (!AllowedPostImageTypes.Contains(contentType, StringComparer.OrdinalIgnoreCase))
                return BadRequest(new { error = "Допустимые форматы: JPEG, PNG, WebP." });
            using var stream = file.OpenReadStream();
            byte[] data;
            string storedContentType;
            try
            {
                (data, storedContentType) = await PostImageProcessor.ProcessAsync(stream, ct);
            }
            catch (Exception ex) when (ex is UnknownImageFormatException or InvalidImageContentException or InvalidOperationException)
            {
                return BadRequest(new { error = "Не удалось прочитать изображение. Допустимые форматы: JPEG, PNG, WebP." });
            }
            var img = new PostImage
            {
                Uuid = FloraUuid.NewGuid(),
                PostUuid = postUuid,
                ContentType = storedContentType,
                Data = data,
                SortOrder = existingCount + i
            };
            _content.PostImages.Add(img);
            uploaded.Add(img.Uuid);
        }
        await SaveAllAsync(ct);
        return Ok(new { imageUuids = uploaded });
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "UploadPostImages failed for post {PostUuid}", postUuid);
            return StatusCode(StatusCodes.Status500InternalServerError,
                new { error = "Не удалось сохранить фото. Попробуйте другой файл или позже." });
        }
    }

    /// <summary>Получить изображение поста по UUID (публичный доступ).</summary>
    [HttpGet("posts/images/{uuid:guid}")]
    [AllowAnonymous]
    public async Task<IActionResult> GetPostImage(Guid uuid, CancellationToken ct = default)
    {
        var img = await _content.PostImages.AsNoTracking().FirstOrDefaultAsync(i => i.Uuid == uuid, ct);
        if (img == null || img.Data.Length == 0)
            return NotFound();
        // NOTE: post media is served to anonymous <img>/<video> tags (no bearer token), so it
        // cannot be gated by membership here without breaking legitimate viewers. Private-community
        // exposure is mitigated by gating the post listing/comments; direct-by-UUID access remains a
        // documented MVP limitation (see SECURITY.md) pending signed media URLs.
        Response.Headers.CacheControl = "public, max-age=31536000, immutable";
        return File(img.Data, img.ContentType);
    }

    private static readonly string[] AllowedPostVideoTypes = { "video/mp4", "video/quicktime", "video/webm", "video/x-matroska" };
    private const long MaxPostVideoBytes = 200L * 1024 * 1024; // 200 МБ оригинал до транскода
    private const int MaxPostVideoDurationMs = 10 * 60 * 1000;

    /// <summary>
    /// Загрузить видео к посту (multipart, поле "file"). Только автор, 1 видео на пост.
    /// Оригинал сохраняется во временный файл и транскодируется в AV1 фоновым воркером.
    /// </summary>
    [HttpPost("posts/{postUuid:guid}/video")]
    [Authorize]
    [RequestSizeLimit(MaxPostVideoBytes + 1024 * 1024)]
    [EnableRateLimiting(SocialRateLimitPolicies.Upload)]
    public async Task<IActionResult> UploadPostVideo(Guid postUuid, IFormFile? file, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var post = await _content.UserPosts.AsNoTracking().FirstOrDefaultAsync(p => p.PostUuid == postUuid && !p.IsDeleted, ct);
        if (post == null)
            return NotFound(new { error = "Пост не найден." });
        if (post.AuthorUserUuid != userUuid)
            return Forbid();
        if (file == null || file.Length == 0)
            return BadRequest(new { error = "Выберите видеофайл (MP4, MOV, WebM или MKV, до 200 МБ)." });
        if (file.Length > MaxPostVideoBytes)
            return BadRequest(new { error = "Видео не более 200 МБ." });
        var contentType = file.ContentType?.Split(';')[0].Trim() ?? "";
        if (!AllowedPostVideoTypes.Contains(contentType, StringComparer.OrdinalIgnoreCase))
            return BadRequest(new { error = "Допустимые форматы: MP4, MOV, WebM, MKV." });
        if (await _content.PostVideos.AsNoTracking().AnyAsync(v => v.PostUuid == postUuid, ct))
            return BadRequest(new { error = "К посту уже прикреплено видео." });
        if (!await _videoTranscoder.IsAvailableAsync(ct))
            return StatusCode(StatusCodes.Status503ServiceUnavailable,
                new { error = "Обработка видео временно недоступна (на сервере не настроен ffmpeg с SVT-AV1)." });

        var tempPath = Path.Combine(Path.GetTempPath(), $"flora-upload-{Guid.NewGuid():N}{Path.GetExtension(file.FileName)}");
        try
        {
            await using (var target = System.IO.File.Create(tempPath))
            await using (var source = file.OpenReadStream())
            {
                await source.CopyToAsync(target, ct);
            }

            VideoProbeResult probe;
            try
            {
                probe = await _videoTranscoder.ProbeAsync(tempPath, ct);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Не удалось прочитать загруженное видео для поста {PostUuid}.", postUuid);
                System.IO.File.Delete(tempPath);
                return BadRequest(new { error = "Не удалось прочитать видеофайл. Допустимые форматы: MP4, MOV, WebM, MKV." });
            }
            if (probe.DurationMs > MaxPostVideoDurationMs)
            {
                System.IO.File.Delete(tempPath);
                return BadRequest(new { error = "Видео не длиннее 10 минут." });
            }

            var video = new PostVideo
            {
                Uuid = FloraUuid.NewGuid(),
                PostUuid = postUuid,
                Status = PostVideoStatus.Processing,
                Width = probe.Width,
                Height = probe.Height,
                DurationMs = probe.DurationMs,
            };
            _content.PostVideos.Add(video);
            await SaveAllAsync(ct);
            await _videoQueue.EnqueueAsync(new PostVideoTranscodeJob(video.Uuid, tempPath), ct);
            return Ok(new { videoUuid = video.Uuid, status = "processing" });
        }
        catch
        {
            try { System.IO.File.Delete(tempPath); } catch { /* уже удалён */ }
            throw;
        }
    }

    /// <summary>Видеофайл поста (AV1 MP4) с поддержкой Range — перемотка без полной загрузки.</summary>
    [HttpGet("posts/videos/{uuid:guid}")]
    [AllowAnonymous]
    public async Task<IActionResult> GetPostVideo(Guid uuid, CancellationToken ct = default)
    {
        var video = await _content.PostVideos.AsNoTracking().FirstOrDefaultAsync(v => v.Uuid == uuid, ct);
        if (video == null || video.Status != PostVideoStatus.Ready || video.Data.Length == 0)
            return NotFound();
        // See GetPostImage: anonymous <video> requests cannot carry auth; direct-by-UUID access to
        // private-community media is a documented MVP limitation pending signed media URLs.
        Response.Headers.CacheControl = "public, max-age=31536000, immutable";
        return File(video.Data, video.ContentType, enableRangeProcessing: true);
    }

    /// <summary>AVIF-постер видео поста.</summary>
    [HttpGet("posts/videos/{uuid:guid}/poster")]
    [AllowAnonymous]
    public async Task<IActionResult> GetPostVideoPoster(Guid uuid, CancellationToken ct = default)
    {
        var video = await _content.PostVideos.AsNoTracking()
            .Where(v => v.Uuid == uuid)
            .Select(v => new { v.PosterData, v.PosterContentType })
            .FirstOrDefaultAsync(ct);
        if (video == null || video.PosterData.Length == 0)
            return NotFound();
        Response.Headers.CacheControl = "public, max-age=31536000, immutable";
        return File(video.PosterData, video.PosterContentType);
    }

    /// <summary>Статус видео поста (для поллинга после загрузки, пока идёт транскодирование).</summary>
    [HttpGet("posts/{postUuid:guid}/video/status")]
    [AllowAnonymous]
    public async Task<IActionResult> GetPostVideoStatus(Guid postUuid, CancellationToken ct = default)
    {
        var video = await _content.PostVideos.AsNoTracking()
            .Where(v => v.PostUuid == postUuid)
            .Select(v => new { v.Uuid, v.Status, v.Width, v.Height, v.DurationMs })
            .FirstOrDefaultAsync(ct);
        if (video == null)
            return NotFound();
        return Ok(PostVideoDto(video.Uuid, video.Status, video.Width, video.Height, video.DurationMs));
    }

    private static object PostVideoDto(Guid uuid, PostVideoStatus status, int width, int height, int durationMs) => new
    {
        videoUuid = uuid,
        status = status switch
        {
            PostVideoStatus.Ready => "ready",
            PostVideoStatus.Failed => "failed",
            _ => "processing",
        },
        width,
        height,
        durationMs,
    };

    /// <summary>Видео для набора постов: postUuid → DTO (для лент и профилей).</summary>
    private async Task<Dictionary<Guid, object>> GetPostVideosByPostAsync(IReadOnlyCollection<Guid> postUuids, CancellationToken ct)
    {
        if (postUuids.Count == 0)
            return new Dictionary<Guid, object>();
        var rows = await _content.PostVideos.AsNoTracking()
            .Where(v => postUuids.Contains(v.PostUuid))
            .Select(v => new { v.PostUuid, v.Uuid, v.Status, v.Width, v.Height, v.DurationMs })
            .ToListAsync(ct);
        return rows
            .GroupBy(v => v.PostUuid)
            .ToDictionary(g => g.Key, g =>
            {
                var v = g.First();
                return PostVideoDto(v.Uuid, v.Status, v.Width, v.Height, v.DurationMs);
            });
    }

    /// <summary>Комментарии к посту.</summary>
    [HttpGet("posts/{postUuid:guid}/comments")]
    [AllowAnonymous]
    public async Task<IActionResult> GetComments(
        Guid postUuid,
        [FromQuery] int skip = 0,
        [FromQuery] int take = 50,
        [FromQuery] bool includeReplies = true,
        CancellationToken ct = default)
    {
        var access = await ResolvePostAccessAsync(postUuid, ct);
        if (!access.CanView)
            return NotFound(new { error = "Пост не найден." });
        take = Math.Clamp(take, 1, 100);
        var allComments = await _content.PostComments.AsNoTracking()
            .Where(c => c.PostUuid == postUuid && !c.IsDeleted)
            .OrderBy(c => c.CreatedAt)
            .ToListAsync(ct);
        var roots = allComments.Where(c => c.ParentCommentUuid == null).Skip(skip).Take(take).ToList();
        var list = await MapCommentsAsync(allComments, roots, includeReplies, ct);
        return Ok(list);
    }

    /// <summary>Прямые ответы на комментарий (вложенные ветки — отдельными запросами).</summary>
    [HttpGet("posts/{postUuid:guid}/comments/{commentUuid:guid}/replies")]
    [AllowAnonymous]
    public async Task<IActionResult> GetCommentReplies(
        Guid postUuid,
        Guid commentUuid,
        CancellationToken ct = default)
    {
        var access = await ResolvePostAccessAsync(postUuid, ct);
        if (!access.CanView)
            return NotFound(new { error = "Пост не найден." });

        var parentExists = await _content.PostComments.AsNoTracking()
            .AnyAsync(c => c.PostUuid == postUuid && c.CommentUuid == commentUuid && !c.IsDeleted, ct);
        if (!parentExists)
            return NotFound(new { error = "Комментарий не найден." });

        var allComments = await _content.PostComments.AsNoTracking()
            .Where(c => c.PostUuid == postUuid && !c.IsDeleted)
            .OrderBy(c => c.CreatedAt)
            .ToListAsync(ct);
        var direct = allComments.Where(c => c.ParentCommentUuid == commentUuid).ToList();
        var list = await MapCommentsAsync(allComments, direct, includeReplies: false, ct);
        return Ok(list);
    }

    /// <summary>
    /// Resolves whether the current caller may view a post and its media/comments. Personal posts
    /// and posts in public communities are public; posts in private communities are members-only.
    /// </summary>
    private async Task<(bool Found, bool CanView, bool IsPrivate)> ResolvePostAccessAsync(Guid postUuid, CancellationToken ct)
    {
        var meta = await _content.UserPosts.AsNoTracking()
            .Where(p => p.PostUuid == postUuid && !p.IsDeleted)
            .Select(p => new { p.CommunityId })
            .FirstOrDefaultAsync(ct);
        if (meta == null)
            return (false, false, false);
        if (meta.CommunityId == null)
            return (true, true, false);

        var isPrivate = await _content.Communities.AsNoTracking()
            .AnyAsync(c => c.CommunityId == meta.CommunityId && c.IsPrivate, ct);
        if (!isPrivate)
            return (true, true, false);

        var isMember = TryGetCurrentUserUuid(out var viewerUuid) && await _content.UserCommunities.AsNoTracking()
            .AnyAsync(uc => uc.CommunityId == meta.CommunityId && uc.UserUuid == viewerUuid, ct);
        return (true, isMember, true);
    }

    private async Task<List<object>> MapCommentsAsync(
        IReadOnlyList<PostComment> allComments,
        IReadOnlyList<PostComment> nodes,
        bool includeReplies,
        CancellationToken ct)
    {
        var authorIds = allComments.Select(c => c.AuthorUserUuid).Distinct().ToList();
        var accList = await _auth.UserAccounts.AsNoTracking().Where(a => authorIds.Contains(a.UserUuid)).ToListAsync(ct);
        var prList = await _users.UserProfiles.AsNoTracking().Where(p => authorIds.Contains(p.UserUuid)).ToListAsync(ct);
        var accBy = accList.ToDictionary(a => a.UserUuid);
        var prBy = prList.ToDictionary(p => p.UserUuid);

        object MapReply(PostComment c) => new
        {
            commentUuid = c.CommentUuid,
            authorUsername = accBy.GetValueOrDefault(c.AuthorUserUuid)?.Username ?? "",
            authorDisplayName = prBy.GetValueOrDefault(c.AuthorUserUuid)?.DisplayName ?? accBy.GetValueOrDefault(c.AuthorUserUuid)?.Username ?? "",
            content = c.Content,
            createdAt = c.CreatedAt,
            repliesCount = 0,
            replies = Array.Empty<object>()
        };

        object MapNode(PostComment c)
        {
            var directReplies = allComments
                .Where(r => r.ParentCommentUuid == c.CommentUuid)
                .OrderBy(r => r.CreatedAt)
                .ToList();
            return new
            {
                commentUuid = c.CommentUuid,
                authorUsername = accBy.GetValueOrDefault(c.AuthorUserUuid)?.Username ?? "",
                authorDisplayName = prBy.GetValueOrDefault(c.AuthorUserUuid)?.DisplayName ?? accBy.GetValueOrDefault(c.AuthorUserUuid)?.Username ?? "",
                content = c.Content,
                createdAt = c.CreatedAt,
                repliesCount = directReplies.Count,
                replies = includeReplies
                    ? directReplies.Select(MapReply).ToArray()
                    : Array.Empty<object>()
            };
        }

        return nodes.Select(c => MapNode(c)).ToList();
    }

    /// <summary>Добавить комментарий к посту.</summary>
    [HttpPost("posts/{postUuid:guid}/comments")]
    [Authorize]
    [EnableRateLimiting(SocialRateLimitPolicies.Write)]
    public async Task<IActionResult> CreateComment(Guid postUuid, [FromBody] CreateCommentRequest request, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var post = await _content.UserPosts.AsNoTracking()
            .FirstOrDefaultAsync(p => p.PostUuid == postUuid && !p.IsDeleted, ct);
        if (post is null)
            return NotFound(new { error = "Пост не найден." });
        if (!await _profileAccess.CanAccessAsync(userUuid, post.AuthorUserUuid, ProfileAccessField.Comments, ct))
            return StatusCode(StatusCodes.Status403Forbidden, new { error = "Автор ограничил комментарии к своим публикациям." });
        var content = (request.Content ?? "").Trim();
        if (string.IsNullOrEmpty(content))
            return BadRequest(new { error = "Текст комментария не может быть пустым." });
        if (content.Length > 1000)
            return BadRequest(new { error = "Комментарий не более 1000 символов." });

        Guid? parentCommentUuid = request.ParentCommentUuid;
        if (parentCommentUuid is Guid parentUuid)
        {
            if (parentUuid == Guid.Empty)
                return BadRequest(new { error = "Некорректный родительский комментарий." });
            var parent = await _content.PostComments.AsNoTracking()
                .FirstOrDefaultAsync(c => c.PostUuid == postUuid && c.CommentUuid == parentUuid && !c.IsDeleted, ct);
            if (parent is null)
                return NotFound(new { error = "Родительский комментарий не найден." });
            if (parent.ParentCommentUuid is not null)
                return BadRequest(new { error = "Ответы можно оставлять только к корневым комментариям." });
        }

        var comment = new PostComment
        {
            PostUuid = postUuid,
            AuthorUserUuid = userUuid,
            Content = content,
            ParentCommentUuid = parentCommentUuid,
        };
        _content.PostComments.Add(comment);
        await SaveAllAsync(ct);
        _feedRecommendation.InvalidateFeedCache(userUuid);
        await TryNotifyCommentAsync(userUuid, post, comment, parentCommentUuid, ct);
        var account = await _auth.UserAccounts.AsNoTracking().FirstOrDefaultAsync(a => a.UserUuid == userUuid, ct);
        var profile = await _users.UserProfiles.AsNoTracking().FirstOrDefaultAsync(p => p.UserUuid == userUuid, ct);
        return Ok(new { commentUuid = comment.CommentUuid, authorUsername = account?.Username ?? "", authorDisplayName = profile?.DisplayName ?? "", content = comment.Content, createdAt = comment.CreatedAt, repliesCount = 0, replies = Array.Empty<object>() });
    }

    /// <summary>Удалить комментарий (только автор комментария).</summary>
    [HttpDelete("posts/{postUuid:guid}/comments/{commentUuid:guid}")]
    [Authorize]
    public async Task<IActionResult> DeleteComment(Guid postUuid, Guid commentUuid, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var comment = await _content.PostComments.FirstOrDefaultAsync(c => c.PostUuid == postUuid && c.CommentUuid == commentUuid, ct);
        if (comment == null)
            return NotFound(new { error = "Комментарий не найден." });
        if (comment.AuthorUserUuid != userUuid)
            return Forbid();
        if (comment.IsDeleted)
            return NoContent();
        comment.IsDeleted = true;
        comment.DeletedAt = DateTime.UtcNow;
        await SaveAllAsync(ct);
        return NoContent();
    }

    /// <summary>Поставить лайк посту.</summary>
    [HttpPost("posts/{postUuid:guid}/like")]
    [Authorize]
    public async Task<IActionResult> LikePost(Guid postUuid, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var exists = await _content.UserPosts.AsNoTracking().AnyAsync(p => p.PostUuid == postUuid && !p.IsDeleted, ct);
        if (!exists)
            return NotFound(new { error = "Пост не найден." });
        var already = await _content.PostLikes.AnyAsync(l => l.PostUuid == postUuid && l.UserUuid == userUuid, ct);
        if (already)
            return Ok(new { liked = true, likesCount = await _content.PostLikes.CountAsync(l => l.PostUuid == postUuid, ct) });
        _content.PostLikes.Add(new PostLike { PostUuid = postUuid, UserUuid = userUuid });
        await SaveAllAsync(ct);
        _feedRecommendation.InvalidateFeedCache(userUuid);
        await TryNotifyLikeAsync(userUuid, postUuid, ct);
        var count = await _content.PostLikes.CountAsync(l => l.PostUuid == postUuid, ct);
        return Ok(new { liked = true, likesCount = count });
    }

    /// <summary>Убрать лайк с поста.</summary>
    [HttpDelete("posts/{postUuid:guid}/like")]
    [Authorize]
    public async Task<IActionResult> UnlikePost(Guid postUuid, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var like = await _content.PostLikes.FirstOrDefaultAsync(l => l.PostUuid == postUuid && l.UserUuid == userUuid, ct);
        if (like != null)
        {
            _content.PostLikes.Remove(like);
            await SaveAllAsync(ct);
            _feedRecommendation.InvalidateFeedCache(userUuid);
        }
        var count = await _content.PostLikes.CountAsync(l => l.PostUuid == postUuid, ct);
        return Ok(new { liked = false, likesCount = count });
    }

    /// <summary>Сделать репост.</summary>
    [HttpPost("posts/{postUuid:guid}/repost")]
    [Authorize]
    public async Task<IActionResult> RepostPost(Guid postUuid, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var exists = await _content.UserPosts.AsNoTracking().AnyAsync(p => p.PostUuid == postUuid && !p.IsDeleted, ct);
        if (!exists)
            return NotFound(new { error = "Пост не найден." });
        var already = await _content.PostReposts.AnyAsync(r => r.PostUuid == postUuid && r.UserUuid == userUuid, ct);
        if (already)
            return Ok(new { reposted = true, repostsCount = await _content.PostReposts.CountAsync(r => r.PostUuid == postUuid, ct) });
        _content.PostReposts.Add(new PostRepost { PostUuid = postUuid, UserUuid = userUuid });
        await SaveAllAsync(ct);
        _feedRecommendation.InvalidateFeedCache(userUuid);
        var count = await _content.PostReposts.CountAsync(r => r.PostUuid == postUuid, ct);
        return Ok(new { reposted = true, repostsCount = count });
    }

    /// <summary>Убрать репост.</summary>
    [HttpDelete("posts/{postUuid:guid}/repost")]
    [Authorize]
    public async Task<IActionResult> UnrepostPost(Guid postUuid, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var repost = await _content.PostReposts.FirstOrDefaultAsync(r => r.PostUuid == postUuid && r.UserUuid == userUuid, ct);
        if (repost != null)
        {
            _content.PostReposts.Remove(repost);
            await SaveAllAsync(ct);
            _feedRecommendation.InvalidateFeedCache(userUuid);
        }
        var count = await _content.PostReposts.CountAsync(r => r.PostUuid == postUuid, ct);
        return Ok(new { reposted = false, repostsCount = count });
    }

    /// <summary>Записать просмотр поста (1 пользователь — максимум 1 просмотр на пост).</summary>
    [HttpPost("posts/{postUuid:guid}/view")]
    [Authorize]
    public async Task<IActionResult> RecordPostView(Guid postUuid, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var exists = await _content.UserPosts.AsNoTracking().AnyAsync(p => p.PostUuid == postUuid && !p.IsDeleted, ct);
        if (!exists)
            return NotFound(new { error = "Пост не найден." });
        var already = await _content.PostViews.AnyAsync(v => v.PostUuid == postUuid && v.UserUuid == userUuid, ct);
        if (!already)
        {
            _content.PostViews.Add(new PostView { PostUuid = postUuid, UserUuid = userUuid });
            await SaveAllAsync(ct);
        }
        var viewsCount = await _content.PostViews.CountAsync(v => v.PostUuid == postUuid, ct);
        return Ok(new { viewsCount });
    }

    /// <summary>Подписчики пользователя (кто подписан на него).</summary>
    [HttpGet("profile/{username}/followers")]
    [AllowAnonymous]
    public async Task<IActionResult> GetFollowers(string username, [FromQuery] int skip = 0, [FromQuery] int take = 50, CancellationToken ct = default)
    {
        var normalized = NormalizeUsername(username);
        if (string.IsNullOrEmpty(normalized))
            return BadRequest(new { error = "Укажите юзернейм." });
        var account = await _auth.UserAccounts.AsNoTracking().FirstOrDefaultAsync(u => u.Username == normalized, ct);
        if (account == null)
            return NotFound(new { error = "Пользователь не найден." });
        TryGetCurrentUserUuid(out var viewerUuid);
        if (!await _profileAccess.CanAccessAsync(viewerUuid, account.UserUuid, ProfileAccessField.Friends, ct))
            return Ok(Array.Empty<object>());
        take = Math.Clamp(take, 1, 100);
        var links = await _users.UserFollowers.AsNoTracking()
            .Where(f => f.FollowingUserUuid == account.UserUuid)
            .OrderBy(f => f.FollowerUserUuid)
            .Skip(skip).Take(take)
            .ToListAsync(ct);
        var ids = links.Select(l => l.FollowerUserUuid).ToList();
        var accList = await _auth.UserAccounts.AsNoTracking().Where(a => ids.Contains(a.UserUuid)).ToListAsync(ct);
        var prList = await _users.UserProfiles.AsNoTracking().Where(p => ids.Contains(p.UserUuid)).ToListAsync(ct);
        var accBy = accList.ToDictionary(a => a.UserUuid);
        var prBy = prList.ToDictionary(p => p.UserUuid);
        var followerCounts = await GetFollowerCountsByUserUuidAsync(ids, ct);
        var list = ids.Select(uid => new
        {
            Username = accBy.GetValueOrDefault(uid)?.Username ?? "",
            displayName = prBy.GetValueOrDefault(uid)?.DisplayName ?? "",
            followerCount = followerCounts.GetValueOrDefault(uid, 0),
        }).ToList();
        return Ok(list);
    }

    /// <summary>Подписки пользователя (на кого подписан).</summary>
    [HttpGet("profile/{username}/following")]
    [AllowAnonymous]
    public async Task<IActionResult> GetFollowing(string username, [FromQuery] int skip = 0, [FromQuery] int take = 50, CancellationToken ct = default)
    {
        var normalized = NormalizeUsername(username);
        if (string.IsNullOrEmpty(normalized))
            return BadRequest(new { error = "Укажите юзернейм." });
        var account = await _auth.UserAccounts.AsNoTracking().FirstOrDefaultAsync(u => u.Username == normalized, ct);
        if (account == null)
            return NotFound(new { error = "Пользователь не найден." });
        TryGetCurrentUserUuid(out var viewerUuid);
        if (!await _profileAccess.CanAccessAsync(viewerUuid, account.UserUuid, ProfileAccessField.Subscriptions, ct))
            return Ok(Array.Empty<object>());
        take = Math.Clamp(take, 1, 100);
        var links = await _users.UserFollowers.AsNoTracking()
            .Where(f => f.FollowerUserUuid == account.UserUuid)
            .OrderBy(f => f.FollowingUserUuid)
            .Skip(skip).Take(take)
            .ToListAsync(ct);
        var ids = links.Select(l => l.FollowingUserUuid).ToList();
        var accList = await _auth.UserAccounts.AsNoTracking().Where(a => ids.Contains(a.UserUuid)).ToListAsync(ct);
        var prList = await _users.UserProfiles.AsNoTracking().Where(p => ids.Contains(p.UserUuid)).ToListAsync(ct);
        var accBy = accList.ToDictionary(a => a.UserUuid);
        var prBy = prList.ToDictionary(p => p.UserUuid);
        var followerCounts = await GetFollowerCountsByUserUuidAsync(ids, ct);
        var list = ids.Select(uid => new
        {
            Username = accBy.GetValueOrDefault(uid)?.Username ?? "",
            displayName = prBy.GetValueOrDefault(uid)?.DisplayName ?? "",
            followerCount = followerCounts.GetValueOrDefault(uid, 0),
        }).ToList();
        return Ok(list);
    }

    /// <summary>Подписаться на пользователя (текущий пользователь → follower, username → following).</summary>
    [HttpPost("profile/{username}/follow")]
    [Authorize]
    public async Task<IActionResult> FollowUser(string username, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var followerUuid))
            return Unauthorized(new { error = "Необходимо войти в аккаунт." });
        var normalized = NormalizeUsername(username);
        if (string.IsNullOrEmpty(normalized))
            return BadRequest(new { error = "Укажите юзернейм." });
        var account = await FindUserAccountByUsernameAsync(normalized, ct);
        if (account == null)
            return NotFound(new { error = "Пользователь не найден." });
        var followingUuid = account.UserUuid;
        if (followerUuid == followingUuid)
            return BadRequest(new { error = "Нельзя подписаться на себя." });
        var exists = await _users.UserFollowers.AsNoTracking().AnyAsync(f => f.FollowerUserUuid == followerUuid && f.FollowingUserUuid == followingUuid, ct);
        if (exists)
            return Ok(new { message = "Уже подписаны." });
        _users.UserFollowers.Add(new UserFollower { FollowerUserUuid = followerUuid, FollowingUserUuid = followingUuid });
        await SaveAllAsync(ct);
        _feedRecommendation.InvalidateFeedCache(followerUuid);
        _userRecommendation.InvalidateCache(followerUuid);
        await TryNotifyFollowAsync(followerUuid, followingUuid, normalized, ct);
        return Ok(new { message = "Подписка оформлена." });
    }

    /// <summary>Отписаться от пользователя.</summary>
    [HttpDelete("profile/{username}/follow")]
    [Authorize]
    public async Task<IActionResult> UnfollowUser(string username, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var followerUuid))
            return Unauthorized(new { error = "Необходимо войти в аккаунт." });
        var normalized = NormalizeUsername(username);
        if (string.IsNullOrEmpty(normalized))
            return BadRequest(new { error = "Укажите юзернейм." });
        var account = await FindUserAccountByUsernameAsync(normalized, ct);
        if (account == null)
            return NotFound(new { error = "Пользователь не найден." });
        var link = await _users.UserFollowers.FirstOrDefaultAsync(f => f.FollowerUserUuid == followerUuid && f.FollowingUserUuid == account.UserUuid, ct);
        if (link == null)
            return Ok(new { message = "Подписки не было." });
        _users.UserFollowers.Remove(link);
        await SaveAllAsync(ct);
        _feedRecommendation.InvalidateFeedCache(followerUuid);
        _userRecommendation.InvalidateCache(followerUuid);
        return NoContent();
    }

    /// <summary>Сообщества пользователя для блока «Подписки»: только публичные и только те, где пользователь не владелец (созданные им не показываются).</summary>
    [HttpGet("profile/{username}/communities")]
    [AllowAnonymous]
    public async Task<IActionResult> GetCommunities(string username, CancellationToken ct = default)
    {
        var normalized = NormalizeUsername(username);
        if (string.IsNullOrEmpty(normalized))
            return BadRequest(new { error = "Укажите юзернейм." });
        var account = await _auth.UserAccounts.AsNoTracking().FirstOrDefaultAsync(u => u.Username == normalized, ct);
        if (account == null)
            return NotFound(new { error = "Пользователь не найден." });
        var userUuid = account.UserUuid;
        var ownedCommunityIds = await _content.UserCommunities.AsNoTracking()
            .Where(uc => uc.UserUuid == userUuid && uc.Role == "Owner")
            .Select(uc => uc.CommunityId)
            .ToListAsync(ct);
        var publicCommunityIds = await _content.Communities.AsNoTracking()
            .Where(c => !c.IsPrivate)
            .Select(c => c.CommunityId)
            .ToListAsync(ct);
        var showIds = publicCommunityIds.Except(ownedCommunityIds).ToList();
        var list = await _content.UserCommunities.AsNoTracking()
            .Where(uc => uc.UserUuid == userUuid && showIds.Contains(uc.CommunityId))
            .Join(_content.Communities.AsNoTracking(), uc => uc.CommunityId, c => c.CommunityId, (uc, c) => new { name = c.Name, slug = c.Slug })
            .ToListAsync(ct);
        return Ok(list);
    }

    /// <summary>Персональные рекомендации публичных сообществ для текущего пользователя.</summary>
    [HttpGet("communities/recommended")]
    [Authorize]
    public async Task<IActionResult> GetRecommendedCommunities([FromQuery] int take = 30, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var list        = await _communityRecommendation.GetRecommendedAsync(userUuid, take, ct);
        var generatedAt = _communityRecommendation.GetCacheGeneratedAt(userUuid) ?? DateTime.UtcNow;
        var expiresAt   = _communityRecommendation.GetCacheExpiresAt(userUuid) ?? generatedAt.AddSeconds(600);
        return Ok(new
        {
            items = list.Select(c => new
            {
                communityId = c.CommunityId,
                name        = c.Name,
                slug        = c.Slug,
                memberCount = c.MemberCount,
                avatarUuid  = c.AvatarUuid,
            }),
            generatedAt,
            expiresAt,
        });
    }

    /// <summary>Подписаться на публичное сообщество (роль Member).</summary>
    [HttpPost("communities/{communityId:guid}/join")]
    [Authorize]
    public async Task<IActionResult> JoinCommunity(Guid communityId, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var community = await _content.Communities.AsNoTracking()
            .FirstOrDefaultAsync(c => c.CommunityId == communityId, ct);
        if (community == null)
            return NotFound(new { error = "Сообщество не найдено." });
        if (community.IsPrivate)
            return BadRequest(new { error = "Нельзя подписаться на приватное сообщество." });

        var existing = await _content.UserCommunities
            .FirstOrDefaultAsync(uc => uc.CommunityId == communityId && uc.UserUuid == userUuid, ct);
        if (existing != null)
            return Conflict(new { error = "Вы уже состоите в этом сообществе." });

        _content.UserCommunities.Add(new UserCommunity
        {
            UserUuid = userUuid,
            CommunityId = communityId,
            Role = "Member",
            JoinedAt = DateTime.UtcNow,
        });
        await SaveAllAsync(ct);
        _feedRecommendation.InvalidateFeedCache(userUuid);
        _communityRecommendation.InvalidateCache(userUuid);

        var memberCount = await _content.UserCommunities.AsNoTracking()
            .CountAsync(uc => uc.CommunityId == communityId, ct);
        return Ok(new { communityId, name = community.Name, slug = community.Slug, memberCount, role = "Member" });
    }

    /// <summary>Отписаться от публичного сообщества (только участник, не владелец).</summary>
    [HttpDelete("communities/{communityId:guid}/join")]
    [Authorize]
    public async Task<IActionResult> LeaveCommunity(Guid communityId, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Необходимо войти в аккаунт." });

        var link = await _content.UserCommunities
            .FirstOrDefaultAsync(uc => uc.CommunityId == communityId && uc.UserUuid == userUuid, ct);
        if (link == null)
            return Ok(new { message = "Подписки не было." });
        if (link.Role == "Owner")
            return BadRequest(new { error = "Владелец не может отписаться от своего сообщества." });

        _content.UserCommunities.Remove(link);
        await SaveAllAsync(ct);
        _feedRecommendation.InvalidateFeedCache(userUuid);
        _communityRecommendation.InvalidateCache(userUuid);
        return NoContent();
    }

    /// <summary>Список публичных сообществ (для блока «Все сообщества»). Приватные не показываются.</summary>
    [HttpGet("communities")]
    [AllowAnonymous]
    public async Task<IActionResult> GetAllCommunities(CancellationToken ct = default)
    {
        var communities = await _content.Communities.AsNoTracking()
            .Where(c => !c.IsPrivate)
            .OrderBy(c => c.Name)
            .ToListAsync(ct);
        var counts = await _content.UserCommunities.AsNoTracking()
            .Where(uc => communities.Select(x => x.CommunityId).Contains(uc.CommunityId))
            .GroupBy(uc => uc.CommunityId)
            .Select(g => new { CommunityId = g.Key, Count = g.Count() })
            .ToListAsync(ct);
        var countDict = counts.ToDictionary(x => x.CommunityId, x => x.Count);
        var list = communities.Select(c => new
        {
            communityId = c.CommunityId,
            name = c.Name,
            slug = c.Slug,
            memberCount = countDict.GetValueOrDefault(c.CommunityId, 0),
            avatarUuid = c.AvatarUuid
        }).ToList();
        return Ok(list);
    }

    /// <summary>Поиск сообществ по названию или ссылке. Публичные — для всех; свои приватные — только владельцу.</summary>
    [HttpGet("communities/search")]
    [Authorize]
    public async Task<IActionResult> SearchCommunities([FromQuery] string? q, [FromQuery] int skip = 0, [FromQuery] int take = 20, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Необходимо войти в аккаунт." });

        var query = (q ?? "").Trim();
        if (query.Length < 1)
            return Ok(new List<object>());

        take = Math.Clamp(take, 1, 50);
        skip = Math.Max(0, skip);
        var lower = query.ToLower();

        var ownedIds = await _content.UserCommunities.AsNoTracking()
            .Where(uc => uc.UserUuid == userUuid && uc.Role == "Owner")
            .Select(uc => uc.CommunityId)
            .ToListAsync(ct);

        var communities = await _content.Communities.AsNoTracking()
            .Where(c =>
                (c.Name.ToLower().Contains(lower) || c.Slug.ToLower().Contains(lower)) &&
                (!c.IsPrivate || ownedIds.Contains(c.CommunityId)))
            .OrderBy(c => c.Name)
            .Skip(skip)
            .Take(take)
            .ToListAsync(ct);

        if (communities.Count == 0)
            return Ok(new List<object>());

        var communityIds = communities.Select(c => c.CommunityId).ToList();
        var counts = await _content.UserCommunities.AsNoTracking()
            .Where(uc => communityIds.Contains(uc.CommunityId))
            .GroupBy(uc => uc.CommunityId)
            .Select(g => new { CommunityId = g.Key, Count = g.Count() })
            .ToListAsync(ct);
        var countDict = counts.ToDictionary(x => x.CommunityId, x => x.Count);

        var links = await _content.UserCommunities.AsNoTracking()
            .Where(uc => uc.UserUuid == userUuid && communityIds.Contains(uc.CommunityId))
            .ToListAsync(ct);
        var roleByCommunity = links.ToDictionary(x => x.CommunityId, x => x.Role);

        var list = communities.Select(c => new
        {
            communityId = c.CommunityId,
            name = c.Name,
            slug = c.Slug,
            memberCount = countDict.GetValueOrDefault(c.CommunityId, 0),
            avatarUuid = c.AvatarUuid,
            role = roleByCommunity.GetValueOrDefault(c.CommunityId),
        }).ToList();
        return Ok(list);
    }

    /// <summary>Получить сообщество по slug. Для приватного — только участники. В ответе role — роль текущего пользователя (Owner/Member) или null.</summary>
    [HttpGet("communities/slug/{slug}")]
    [AllowAnonymous]
    public async Task<IActionResult> GetCommunityBySlug(string slug, CancellationToken ct = default)
    {
        var normalized = NormalizeSlug(slug);
        if (string.IsNullOrEmpty(normalized))
            return BadRequest(new { error = "Укажите ссылку сообщества." });
        var community = await _content.Communities.AsNoTracking().FirstOrDefaultAsync(c => c.Slug == normalized, ct);
        if (community == null)
            return NotFound(new { error = "Сообщество не найдено." });
        if (community.IsPrivate)
        {
            var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
            if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
                return NotFound(new { error = "Сообщество не найдено." });
            var link = await _content.UserCommunities.AsNoTracking().FirstOrDefaultAsync(uc => uc.CommunityId == community.CommunityId && uc.UserUuid == userUuid, ct);
            if (link == null)
                return NotFound(new { error = "Сообщество не найдено." });
            var memberCount = await _content.UserCommunities.AsNoTracking().CountAsync(uc => uc.CommunityId == community.CommunityId, ct);
            return Ok(new
            {
                communityId = community.CommunityId,
                name = community.Name,
                slug = community.Slug,
                memberCount,
                role = link.Role,
                avatarUuid = community.AvatarUuid,
                isPrivate = link.Role == "Owner" ? community.IsPrivate : (bool?)null,
            });
        }
        var count = await _content.UserCommunities.AsNoTracking().CountAsync(uc => uc.CommunityId == community.CommunityId, ct);
        string? role = null;
        var sub2 = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (!string.IsNullOrEmpty(sub2) && Guid.TryParse(sub2, out var userUuid2))
        {
            var link2 = await _content.UserCommunities.AsNoTracking().FirstOrDefaultAsync(uc => uc.CommunityId == community.CommunityId && uc.UserUuid == userUuid2, ct);
            if (link2 != null) role = link2.Role;
        }
        return Ok(new
        {
            communityId = community.CommunityId,
            name = community.Name,
            slug = community.Slug,
            memberCount = count,
            role,
            avatarUuid = community.AvatarUuid,
            isPrivate = role == "Owner" ? community.IsPrivate : (bool?)null,
        });
    }

    /// <summary>Загрузить аватар сообщества (только владелец). Multipart: файл в поле "file". JPEG/PNG/WebP, до 2 МБ.</summary>
    [HttpPost("communities/{communityId:guid}/avatar")]
    [Authorize]
    [EnableRateLimiting(SocialRateLimitPolicies.Upload)]
    public async Task<IActionResult> UploadCommunityAvatar(Guid communityId, IFormFile? file, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var isOwner = await _content.UserCommunities.AsNoTracking()
            .AnyAsync(uc => uc.CommunityId == communityId && uc.UserUuid == userUuid && uc.Role == "Owner", ct);
        if (!isOwner)
            return Forbid();
        if (file == null || file.Length == 0)
            return BadRequest(new { error = "Выберите файл изображения (JPEG, PNG или WebP, до 2 МБ)." });
        if (file.Length > MaxAvatarSizeBytes)
            return BadRequest(new { error = "Файл не должен превышать 2 МБ." });
        var contentType = file.ContentType?.Split(';')[0].Trim() ?? "";
        if (!AllowedAvatarTypes.Contains(contentType, StringComparer.OrdinalIgnoreCase))
            return BadRequest(new { error = "Допустимые форматы: JPEG, PNG, WebP." });
        var community = await _content.Communities.FindAsync([communityId], ct);
        if (community == null)
            return NotFound(new { error = "Сообщество не найдено." });
        byte[] data;
        string storedContentType;
        try
        {
            using var stream = file.OpenReadStream();
            (data, storedContentType) = await PostImageProcessor.ProcessAsync(stream, ct);
        }
        catch (Exception ex) when (ex is UnknownImageFormatException or InvalidImageContentException or InvalidOperationException)
        {
            return BadRequest(new { error = "Файл не является корректным изображением (JPEG, PNG или WebP)." });
        }
        var avatar = new CommunityAvatar
        {
            Uuid = FloraUuid.NewGuid(),
            CommunityId = communityId,
            ContentType = storedContentType,
            Data = data
        };
        _content.CommunityAvatars.Add(avatar);
        community.AvatarUuid = avatar.Uuid;
        await SaveAllAsync(ct);
        return Ok(new { avatarUuid = avatar.Uuid.ToString() });
    }

    /// <summary>Посты сообщества (последние первые), с данными автора.</summary>
    [HttpGet("communities/{communityId:guid}/posts")]
    [AllowAnonymous]
    public async Task<IActionResult> GetCommunityPosts(Guid communityId, [FromQuery] int skip = 0, [FromQuery] int take = 20, CancellationToken ct = default)
    {
        var community = await _content.Communities.AsNoTracking()
            .Where(c => c.CommunityId == communityId)
            .Select(c => new { c.CommunityId, c.IsPrivate })
            .FirstOrDefaultAsync(ct);
        if (community == null)
            return NotFound(new { error = "Сообщество не найдено." });

        // Private communities expose their posts only to members (prevents IDOR by community id).
        if (community.IsPrivate)
        {
            var isMember = TryGetCurrentUserUuid(out var viewerUuid) && await _content.UserCommunities.AsNoTracking()
                .AnyAsync(uc => uc.CommunityId == communityId && uc.UserUuid == viewerUuid, ct);
            if (!isMember)
                return StatusCode(403, new { error = "Это приватное сообщество." });
        }

        take = Math.Clamp(take, 1, 50);
        var posts = await _content.UserPosts.AsNoTracking()
            .Where(p => p.CommunityId == communityId && !p.IsDeleted)
            .OrderByDescending(p => p.CreatedAt)
            .Skip(skip).Take(take)
            .Select(p => new { p.PostUuid, p.AuthorUserUuid, p.Content, p.CreatedAt })
            .ToListAsync(ct);
        if (posts.Count == 0)
            return Ok(Array.Empty<object>());
        var postUuids = posts.Select(p => p.PostUuid).ToList();
        var authorUuids = posts.Select(p => p.AuthorUserUuid).Distinct().ToList();
        var accounts = await _auth.UserAccounts.AsNoTracking()
            .Where(a => authorUuids.Contains(a.UserUuid))
            .Select(a => new { a.UserUuid, a.Username })
            .ToListAsync(ct);
        var profiles = await _users.UserProfiles.AsNoTracking()
            .Where(p => authorUuids.Contains(p.UserUuid))
            .Select(p => new { p.UserUuid, p.DisplayName, p.AvatarUuid })
            .ToListAsync(ct);
        var accountDict = accounts.ToDictionary(a => a.UserUuid);
        var profileDict = profiles.ToDictionary(p => p.UserUuid);
        var commentCounts = await _content.PostComments.AsNoTracking()
            .Where(c => postUuids.Contains(c.PostUuid) && !c.IsDeleted)
            .GroupBy(c => c.PostUuid)
            .Select(g => new { PostUuid = g.Key, Count = g.Count() })
            .ToListAsync(ct);
        var likeCounts = await _content.PostLikes.AsNoTracking()
            .Where(l => postUuids.Contains(l.PostUuid))
            .GroupBy(l => l.PostUuid)
            .Select(g => new { PostUuid = g.Key, Count = g.Count() })
            .ToListAsync(ct);
        var repostCounts = await _content.PostReposts.AsNoTracking()
            .Where(r => postUuids.Contains(r.PostUuid))
            .GroupBy(r => r.PostUuid)
            .Select(g => new { PostUuid = g.Key, Count = g.Count() })
            .ToListAsync(ct);
        var viewCounts = await _content.PostViews.AsNoTracking()
            .Where(v => postUuids.Contains(v.PostUuid))
            .GroupBy(v => v.PostUuid)
            .Select(g => new { PostUuid = g.Key, Count = g.Count() })
            .ToListAsync(ct);
        var commentDict = commentCounts.ToDictionary(x => x.PostUuid, x => x.Count);
        var likeDict = likeCounts.ToDictionary(x => x.PostUuid, x => x.Count);
        var repostDict = repostCounts.ToDictionary(x => x.PostUuid, x => x.Count);
        var viewDict = viewCounts.ToDictionary(x => x.PostUuid, x => x.Count);
        Guid? currentUserUuid = null;
        if (User.Identity?.IsAuthenticated == true && Guid.TryParse(User.FindFirst(ClaimTypes.NameIdentifier)?.Value, out var uid))
            currentUserUuid = uid;
        HashSet<Guid>? likedPostIds = null;
        HashSet<Guid>? repostedPostIds = null;
        HashSet<Guid>? commentedPostIds = null;
        if (currentUserUuid.HasValue)
        {
            likedPostIds = (await _content.PostLikes.AsNoTracking()
                .Where(l => l.UserUuid == currentUserUuid && postUuids.Contains(l.PostUuid))
                .Select(l => l.PostUuid)
                .ToListAsync(ct)).ToHashSet();
            repostedPostIds = (await _content.PostReposts.AsNoTracking()
                .Where(r => r.UserUuid == currentUserUuid && postUuids.Contains(r.PostUuid))
                .Select(r => r.PostUuid)
                .ToListAsync(ct)).ToHashSet();
            commentedPostIds = (await _content.PostComments.AsNoTracking()
                .Where(c => c.AuthorUserUuid == currentUserUuid && postUuids.Contains(c.PostUuid) && !c.IsDeleted)
                .Select(c => c.PostUuid)
                .Distinct()
                .ToListAsync(ct)).ToHashSet();
        }
        var postImagesCommunity = await _content.PostImages.AsNoTracking().Where(i => postUuids.Contains(i.PostUuid)).OrderBy(i => i.PostUuid).ThenBy(i => i.SortOrder).Select(i => new { i.PostUuid, i.Uuid }).ToListAsync(ct);
        var imagesByPostCommunity = postImagesCommunity.GroupBy(i => i.PostUuid).ToDictionary(g => g.Key, g => g.Select(x => x.Uuid).ToList());
        var videosByPostCommunity = await GetPostVideosByPostAsync(postUuids, ct);
        var result = posts.Select(p =>
        {
            var acc = accountDict.GetValueOrDefault(p.AuthorUserUuid);
            var prf = profileDict.GetValueOrDefault(p.AuthorUserUuid);
            return new
            {
                postUuid = p.PostUuid,
                content = p.Content,
                createdAt = p.CreatedAt,
                authorUserUuid = p.AuthorUserUuid,
                authorUsername = acc?.Username ?? "",
                authorDisplayName = prf?.DisplayName ?? acc?.Username ?? "",
                authorAvatarUuid = prf?.AvatarUuid,
                imageUuids = imagesByPostCommunity.GetValueOrDefault(p.PostUuid, new List<Guid>()),
                video = videosByPostCommunity.GetValueOrDefault(p.PostUuid),
                commentsCount = commentDict.GetValueOrDefault(p.PostUuid, 0),
                likesCount = likeDict.GetValueOrDefault(p.PostUuid, 0),
                repostsCount = repostDict.GetValueOrDefault(p.PostUuid, 0),
                viewsCount = viewDict.GetValueOrDefault(p.PostUuid, 0),
                liked = likedPostIds?.Contains(p.PostUuid) ?? false,
                reposted = repostedPostIds?.Contains(p.PostUuid) ?? false,
                hasCommented = commentedPostIds?.Contains(p.PostUuid) ?? false
            };
        });
        return Ok(result);
    }

    /// <summary>Создать сообщество (текущий пользователь становится владельцем, сообщество — приватное).</summary>
    [HttpPost("communities")]
    [Authorize]
    [EnableRateLimiting(SocialRateLimitPolicies.Write)]
    public async Task<IActionResult> CreateCommunity([FromBody] CreateCommunityRequest request, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Необходимо войти в аккаунт." });

        var name = (request.Name ?? "").Trim();
        if (string.IsNullOrEmpty(name))
            return BadRequest(new { error = "Укажите название сообщества." });
        if (name.Length > 100)
            return BadRequest(new { error = "Название не более 100 символов." });

        if (!string.IsNullOrWhiteSpace(request.Slug) && !LatinIdentifiers.HasOnlySlugChars(request.Slug))
            return BadRequest(new { error = LatinIdentifiers.SlugFormatMessage });

        var slug = NormalizeSlug(string.IsNullOrWhiteSpace(request.Slug) ? name : request.Slug);
        if (string.IsNullOrEmpty(slug))
            return BadRequest(new { error = "Ссылка не может быть пустой. Используйте латиницу, цифры, дефис или подчёркивание." });
        if (slug.Length > 100)
            return BadRequest(new { error = "Ссылка не более 100 символов." });

        if (await _content.Communities.AsNoTracking().AnyAsync(c => c.Slug == slug, ct))
            return Conflict(new { error = "Сообщество с такой ссылкой уже существует." });
        if (CommunityReservedSlugs.IsReserved(slug))
            return BadRequest(new { error = "Эта ссылка зарезервирована системой и недоступна для регистрации." });

        var community = new Community
        {
            CommunityId = FloraUuid.NewGuid(),
            Name = name,
            Slug = slug,
            IsPrivate = request.IsPrivate ?? true
        };
        _content.Communities.Add(community);
        _content.UserCommunities.Add(new UserCommunity { UserUuid = userUuid, CommunityId = community.CommunityId, Role = "Owner" });
        await SaveAllAsync(ct);

        return Ok(new
        {
            communityId = community.CommunityId,
            name = community.Name,
            slug = community.Slug,
            memberCount = 1,
            isPrivate = community.IsPrivate,
        });
    }

    /// <summary>Сообщества, созданные текущим пользователем (роль Owner).</summary>
    [HttpGet("communities/owned")]
    [Authorize]
    public async Task<IActionResult> GetOwnedCommunities(CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Необходимо войти в аккаунт." });

        var list = await _content.UserCommunities.AsNoTracking()
            .Where(uc => uc.UserUuid == userUuid && uc.Role == "Owner")
            .Join(_content.Communities.AsNoTracking(), uc => uc.CommunityId, c => c.CommunityId, (uc, c) => c)
            .ToListAsync(ct);
        var counts = await _content.UserCommunities.AsNoTracking()
            .Where(uc => list.Select(x => x.CommunityId).Contains(uc.CommunityId))
            .GroupBy(uc => uc.CommunityId)
            .Select(g => new { CommunityId = g.Key, Count = g.Count() })
            .ToListAsync(ct);
        var countDict = counts.ToDictionary(x => x.CommunityId, x => x.Count);
        var result = list.Select(c => new
        {
            communityId = c.CommunityId,
            name = c.Name,
            slug = c.Slug,
            memberCount = countDict.GetValueOrDefault(c.CommunityId, 0),
            role = "Owner",
            avatarUuid = c.AvatarUuid,
            isPrivate = c.IsPrivate,
        }).ToList();
        return Ok(result);
    }

    /// <summary>Обновить сообщество (только владелец): название, slug и приватность.</summary>
    [HttpPatch("communities/{communityId:guid}")]
    [Authorize]
    public async Task<IActionResult> UpdateCommunity(Guid communityId, [FromBody] UpdateCommunityRequest request, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Необходимо войти в аккаунт." });

        var link = await _content.UserCommunities.FirstOrDefaultAsync(uc => uc.CommunityId == communityId && uc.UserUuid == userUuid && uc.Role == "Owner", ct);
        if (link == null)
            return NotFound(new { error = "Сообщество не найдено или у вас нет прав на редактирование." });

        var community = await _content.Communities.FindAsync([communityId], ct);
        if (community == null)
            return NotFound(new { error = "Сообщество не найдено." });

        if (!string.IsNullOrWhiteSpace(request.Name))
        {
            var name = request.Name.Trim();
            if (name.Length > 100)
                return BadRequest(new { error = "Название не более 100 символов." });
            community.Name = name;
        }

        if (request.Slug != null)
        {
            if (!string.IsNullOrWhiteSpace(request.Slug) && !LatinIdentifiers.HasOnlySlugChars(request.Slug))
                return BadRequest(new { error = LatinIdentifiers.SlugFormatMessage });

            var slug = NormalizeSlug(string.IsNullOrWhiteSpace(request.Slug) ? community.Name : request.Slug);
            if (string.IsNullOrEmpty(slug))
                return BadRequest(new { error = "Ссылка не может быть пустой. Используйте латиницу, цифры, дефис или подчёркивание." });
            if (slug.Length > 100)
                return BadRequest(new { error = "Ссылка не более 100 символов." });
            if (slug != community.Slug && await _content.Communities.AsNoTracking().AnyAsync(c => c.Slug == slug, ct))
                return Conflict(new { error = "Сообщество с такой ссылкой уже существует." });
            if (slug != community.Slug && CommunityReservedSlugs.IsReserved(slug))
                return BadRequest(new { error = "Эта ссылка зарезервирована системой и недоступна для регистрации." });
            community.Slug = slug;
        }

        if (request.IsPrivate.HasValue)
            community.IsPrivate = request.IsPrivate.Value;

        await SaveAllAsync(ct);
        var memberCount = await _content.UserCommunities.CountAsync(uc => uc.CommunityId == communityId, ct);
        return Ok(new
        {
            communityId = community.CommunityId,
            name = community.Name,
            slug = community.Slug,
            memberCount,
            isPrivate = community.IsPrivate,
            avatarUuid = community.AvatarUuid,
        });
    }

    /// <summary>Удалить сообщество (только владелец).</summary>
    [HttpDelete("communities/{communityId:guid}")]
    [Authorize]
    public async Task<IActionResult> DeleteCommunity(Guid communityId, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Необходимо войти в аккаунт." });

        var link = await _content.UserCommunities.FirstOrDefaultAsync(uc => uc.CommunityId == communityId && uc.UserUuid == userUuid && uc.Role == "Owner", ct);
        if (link == null)
            return NotFound(new { error = "Сообщество не найдено или у вас нет прав на удаление." });

        var community = await _content.Communities.FindAsync([communityId], ct);
        if (community == null)
            return NotFound(new { error = "Сообщество не найдено." });

        var members = await _content.UserCommunities.Where(uc => uc.CommunityId == communityId).ToListAsync(ct);
        _content.UserCommunities.RemoveRange(members);
        _content.Communities.Remove(community);
        await SaveAllAsync(ct);
        return NoContent();
    }

    // ─── E2E ключи и сообщения ──────────────────────────────────────────────

    /// <summary>Сохранить публичный ключ текущего пользователя для E2E. Приватный ключ хранится только в браузере.</summary>
    [HttpPut("me/e2e-public-key")]
    [HttpPost("me/e2e-public-key")]
    [Authorize]
    public async Task<IActionResult> SetMyE2EPublicKey([FromBody] SetE2EPublicKeyRequest? request, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var publicKeyBase64 = (request?.PublicKeyBase64 ?? "").Trim();
        if (string.IsNullOrEmpty(publicKeyBase64) || publicKeyBase64.Length > 2000)
            return BadRequest(new { error = "Некорректный публичный ключ. Отправьте JSON: { \"publicKeyBase64\": \"...\", \"deviceUuid\": \"...\" }." });

        Guid? deviceUuid = null;
        if (!string.IsNullOrWhiteSpace(request?.DeviceUuid) && Guid.TryParse(request.DeviceUuid.Trim(), out var parsedDevice))
            deviceUuid = parsedDevice;

        try
        {
            var key = await _msg.UserE2EKeys.FindAsync([userUuid], ct);
            if (key == null)
            {
                key = new UserE2EKey
                {
                    UserUuid = userUuid,
                    PublicKeyBase64 = publicKeyBase64,
                    DeviceUuid = deviceUuid ?? FloraUuid.NewGuid()
                };
                _msg.UserE2EKeys.Add(key);
            }
            else
            {
                key.PublicKeyBase64 = publicKeyBase64;
                if (deviceUuid.HasValue)
                    key.DeviceUuid = deviceUuid;
                else if (!key.DeviceUuid.HasValue)
                    key.DeviceUuid = FloraUuid.NewGuid();
                key.UpdatedAt = DateTime.UtcNow;
            }
            await SaveAllAsync(ct);
            return Ok(new { message = "Ключ сохранён.", deviceUuid = key.DeviceUuid });
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "SetMyE2EPublicKey failed for {UserUuid}", userUuid);
            var detail = ex.GetBaseException().Message;
            return StatusCode(500, new { error = "Ошибка сохранения ключа.", detail });
        }
    }

    /// <summary>Получить публичный ключ пользователя по UUID (для шифрования сообщений ему).</summary>
    [HttpGet("users/{userUuid:guid}/e2e-public-key")]
    [Authorize]
    public async Task<IActionResult> GetUserE2EPublicKey(Guid userUuid, CancellationToken ct = default)
    {
        try
        {
            var key = await _msg.UserE2EKeys.AsNoTracking().FirstOrDefaultAsync(k => k.UserUuid == userUuid, ct);
            if (key == null)
                return NotFound(new { error = "Публичный ключ пользователя не найден. Возможно, он ещё не открывал сообщения в этом браузере." });
            return Ok(new { publicKeyBase64 = key.PublicKeyBase64, deviceUuid = key.DeviceUuid });
        }
        catch (Exception ex)
        {
            return StatusCode(500, new { error = "Ошибка получения ключа.", detail = ex.Message });
        }
    }

    /// <summary>Список диалогов: пользователи, с которыми есть переписка, последнее сообщение и кол-во непрочитанных. E2E: lastMessageEncryptedForMe — зашифрованный текст для текущего пользователя.</summary>
    [HttpGet("conversations")]
    [Authorize]
    public async Task<IActionResult> GetConversations(CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        await _presence.TouchAsync(userUuid, ct);

        var myMessages = await _msg.UserMessages.AsNoTracking()
            .Where(m => m.SenderUserUuid == userUuid || m.ReceiverUserUuid == userUuid)
            .OrderByDescending(m => m.CreatedAt)
            .ToListAsync(ct);

        var otherUserUuids = myMessages
            .Select(m => m.SenderUserUuid == userUuid ? m.ReceiverUserUuid : m.SenderUserUuid)
            .Distinct()
            .ToList();

        if (otherUserUuids.Count == 0)
            return Ok(Array.Empty<object>());

        var accounts = await _auth.UserAccounts.AsNoTracking()
            .Where(a => otherUserUuids.Contains(a.UserUuid))
            .Select(a => new { a.UserUuid, a.Username })
            .ToListAsync(ct);
        var profiles = await _users.UserProfiles.AsNoTracking()
            .Where(p => otherUserUuids.Contains(p.UserUuid))
            .Select(p => new { p.UserUuid, p.DisplayName, p.AvatarUuid })
            .ToListAsync(ct);
        Dictionary<Guid, string?> e2eKeyByUuid;
        try
        {
            var e2eKeys = await _msg.UserE2EKeys.AsNoTracking()
                .Where(k => otherUserUuids.Contains(k.UserUuid))
                .Select(k => new { k.UserUuid, k.PublicKeyBase64 })
                .ToListAsync(ct);
            e2eKeyByUuid = e2eKeys.ToDictionary(k => k.UserUuid, k => (string?)k.PublicKeyBase64);
        }
        catch
        {
            e2eKeyByUuid = new Dictionary<Guid, string?>();
        }
        var accountByUuid = accounts.ToDictionary(a => a.UserUuid);
        var profileByUuid = profiles.ToDictionary(p => p.UserUuid);

        var lastByOther = new Dictionary<Guid, (Guid MessageUuid, string? Content, string? EncryptedForMe, DateTime CreatedAt, bool IsFromThem, bool IsRead)>();
        var unreadByOther = new Dictionary<Guid, int>();
        var lastFromThemByOther = new Dictionary<Guid, DateTime>();

        foreach (var m in myMessages)
        {
            var other = m.SenderUserUuid == userUuid ? m.ReceiverUserUuid : m.SenderUserUuid;
            var isFromThem = m.SenderUserUuid != userUuid;
            if (isFromThem && !lastFromThemByOther.ContainsKey(other))
                lastFromThemByOther[other] = m.CreatedAt;
            var encryptedForMe = userUuid == m.ReceiverUserUuid ? m.EncryptedForReceiver : m.EncryptedForSender;
            if (!lastByOther.ContainsKey(other))
            {
                lastByOther[other] = (m.MessageUuid, m.Content, encryptedForMe, m.CreatedAt, isFromThem, m.IsRead);
                if (isFromThem && !m.IsRead) unreadByOther[other] = 1;
            }
            else
            {
                if (isFromThem && !m.IsRead)
                    unreadByOther[other] = unreadByOther.GetValueOrDefault(other, 0) + 1;
            }
        }

        var lastSeenMap = await _presence.GetLastSeenUtcByUserUuidsAsync(otherUserUuids, ct);
        var utcNow = DateTime.UtcNow;
        var list = new List<object>();
        foreach (var otherUuid in otherUserUuids.OrderByDescending(id => lastByOther[id].CreatedAt))
        {
            var acc = accountByUuid.GetValueOrDefault(otherUuid);
            var prf = profileByUuid.GetValueOrDefault(otherUuid);
            var (msgUuid, content, encryptedForMe, createdAt, isFromThem, isRead) = lastByOther[otherUuid];
            var lastMessageContent = content != null
                ? (content.Length > 80 ? content[..80] + "…" : content)
                : null;
            var canSeeOnline = await _profileAccess.CanAccessAsync(userUuid, otherUuid, ProfileAccessField.OnlineStatus, ct);
            var (otherUserIsOnline, otherUserLastSeenAt) = UserOnlineStatusHelper.ResolveForViewer(
                userUuid, otherUuid, canSeeOnline, lastSeenMap, utcNow);
            list.Add(new
            {
                otherUserUuid = otherUuid,
                otherUsername = acc?.Username ?? "",
                otherDisplayName = prf?.DisplayName ?? acc?.Username ?? "",
                otherAvatarUuid = prf?.AvatarUuid?.ToString(),
                otherUserE2EPublicKeyBase64 = e2eKeyByUuid.GetValueOrDefault(otherUuid),
                lastMessageUuid = msgUuid,
                lastMessageContent,
                lastMessageEncryptedForMe = encryptedForMe,
                lastMessageIsFromMe = !lastByOther[otherUuid].IsFromThem,
                lastMessageAt = createdAt,
                unreadCount = unreadByOther.GetValueOrDefault(otherUuid, 0),
                otherUserIsOnline,
                otherUserLastSeenAt
            });
        }

        return Ok(list);
    }

    /// <summary>Сообщения с пользователем (постранично, последние первые). E2E: content — для старых сообщений, encryptedForMe — зашифрованный текст для текущего пользователя (расшифровывается в браузере).</summary>
    [HttpGet("conversations/with/{otherUserUuid:guid}")]
    [Authorize]
    public async Task<IActionResult> GetMessagesWithUser(Guid otherUserUuid, [FromQuery] int skip = 0, [FromQuery] int take = 50, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        if (otherUserUuid == userUuid)
            return BadRequest(new { error = "Нельзя запросить переписку с самим собой." });

        take = Math.Clamp(take, 1, 100);
        var messages = await _msg.UserMessages.AsNoTracking()
            .Where(m => (m.SenderUserUuid == userUuid && m.ReceiverUserUuid == otherUserUuid) ||
                        (m.SenderUserUuid == otherUserUuid && m.ReceiverUserUuid == userUuid))
            .OrderByDescending(m => m.CreatedAt)
            .Skip(skip).Take(take)
            .Select(m => new { m.MessageUuid, m.SenderUserUuid, m.ReceiverUserUuid, m.Content, m.EncryptedForReceiver, m.EncryptedForSender, m.CreatedAt, m.IsRead })
            .ToListAsync(ct);

        var result = messages.Select(m =>
        {
            var encryptedForMe = userUuid == m.ReceiverUserUuid ? m.EncryptedForReceiver : m.EncryptedForSender;
            return new
            {
                messageUuid = m.MessageUuid,
                senderUserUuid = m.SenderUserUuid,
                receiverUserUuid = m.ReceiverUserUuid,
                content = m.Content,
                encryptedForMe,
                createdAt = m.CreatedAt,
                isRead = m.IsRead,
                isFromMe = m.SenderUserUuid == userUuid
            };
        }).ToList();

        return Ok(result);
    }

    /// <summary>Загрузить зашифрованный аудиоблоб голосового сообщения. Сервер не расшифровывает содержимое.</summary>
    [HttpPost("messages/voice-assets")]
    [Authorize]
    [RequestSizeLimit(MaxVoiceAssetBytes + 1024 * 1024)]
    [EnableRateLimiting(SocialRateLimitPolicies.Upload)]
    public async Task<IActionResult> UploadMessageVoiceAsset(
        [FromForm] Guid toUserUuid,
        [FromForm] int durationMs,
        [FromForm] IFormFile? file,
        CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        if (toUserUuid == userUuid)
            return BadRequest(new { error = "Нельзя отправить голосовое себе." });
        if (durationMs <= 0 || durationMs > MaxVoiceAssetDurationMs)
            return BadRequest(new { error = "Недопустимая длительность голосового сообщения." });
        if (file == null || file.Length <= 0)
            return BadRequest(new { error = "Файл голосового сообщения пуст." });
        if (file.Length > MaxVoiceAssetBytes)
            return BadRequest(new { error = "Голосовое сообщение слишком большое." });

        var receiverExists = await _auth.UserAccounts.AsNoTracking().AnyAsync(a => a.UserUuid == toUserUuid, ct);
        if (!receiverExists)
            return NotFound(new { error = "Пользователь не найден." });

        await using var stream = file.OpenReadStream();
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms, ct);

        var contentType = file.ContentType?.Split(';')[0].Trim();
        if (string.IsNullOrWhiteSpace(contentType))
            contentType = "application/octet-stream";

        var asset = new UserMessageVoiceAsset
        {
            SenderUserUuid = userUuid,
            ReceiverUserUuid = toUserUuid,
            ContentType = contentType,
            DurationMs = durationMs,
            EncryptedBytes = ms.ToArray()
        };
        _msg.UserMessageVoiceAssets.Add(asset);
        await SaveAllAsync(ct);

        return Ok(new
        {
            voiceAssetUuid = asset.VoiceAssetUuid,
            contentType = asset.ContentType,
            durationMs = asset.DurationMs
        });
    }

    /// <summary>Скачать зашифрованный аудиоблоб голосового сообщения для участника диалога.</summary>
    [HttpGet("messages/voice-assets/{voiceAssetUuid:guid}")]
    [Authorize]
    public async Task<IActionResult> GetMessageVoiceAsset(Guid voiceAssetUuid, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var asset = await _msg.UserMessageVoiceAssets.AsNoTracking()
            .FirstOrDefaultAsync(a => a.VoiceAssetUuid == voiceAssetUuid, ct);
        if (asset == null)
            return NotFound(new { error = "Голосовое сообщение не найдено." });

        var canRead = asset.SenderUserUuid == userUuid || asset.ReceiverUserUuid == userUuid;
        if (!canRead && asset.MessageUuid.HasValue)
        {
            canRead = await _msg.UserMessages.AsNoTracking().AnyAsync(m =>
                m.MessageUuid == asset.MessageUuid.Value &&
                (m.SenderUserUuid == userUuid || m.ReceiverUserUuid == userUuid), ct);
        }

        if (!canRead)
            return Forbid();

        Response.Headers["X-Flora-Voice-Duration-Ms"] = asset.DurationMs.ToString();
        Response.Headers["X-Flora-Voice-Content-Type"] = asset.ContentType;
        return File(asset.EncryptedBytes, "application/octet-stream");
    }

    /// <summary>Загрузить зашифрованный блоб фото в сообщении. Сервер не расшифровывает содержимое.</summary>
    [HttpPost("messages/image-assets")]
    [Authorize]
    [RequestSizeLimit(MaxMessageImageBytes + 1024 * 1024)]
    [EnableRateLimiting(SocialRateLimitPolicies.Upload)]
    public async Task<IActionResult> UploadMessageImageAsset(
        [FromForm] Guid toUserUuid,
        [FromForm] string? contentType,
        [FromForm] IFormFile? file,
        CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        if (toUserUuid == userUuid)
            return BadRequest(new { error = "Нельзя отправить фото себе." });
        if (file == null || file.Length <= 0)
            return BadRequest(new { error = "Файл фото пуст." });
        if (file.Length > MaxMessageImageBytes)
            return BadRequest(new { error = "Фото слишком большое." });

        var receiverExists = await _auth.UserAccounts.AsNoTracking().AnyAsync(a => a.UserUuid == toUserUuid, ct);
        if (!receiverExists)
            return NotFound(new { error = "Пользователь не найден." });

        await using var stream = file.OpenReadStream();
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms, ct);

        var storedContentType = contentType?.Split(';')[0].Trim();
        if (string.IsNullOrWhiteSpace(storedContentType))
            storedContentType = file.ContentType?.Split(';')[0].Trim();
        if (string.IsNullOrWhiteSpace(storedContentType))
            storedContentType = "application/octet-stream";

        var asset = new UserMessageImageAsset
        {
            SenderUserUuid = userUuid,
            ReceiverUserUuid = toUserUuid,
            ContentType = storedContentType,
            EncryptedBytes = ms.ToArray()
        };
        _msg.UserMessageImageAssets.Add(asset);
        await SaveAllAsync(ct);

        return Ok(new
        {
            imageAssetUuid = asset.ImageAssetUuid,
            contentType = asset.ContentType
        });
    }

    /// <summary>Скачать зашифрованный блоб фото сообщения для участника диалога.</summary>
    [HttpGet("messages/image-assets/{imageAssetUuid:guid}")]
    [Authorize]
    public async Task<IActionResult> GetMessageImageAsset(Guid imageAssetUuid, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var asset = await _msg.UserMessageImageAssets.AsNoTracking()
            .FirstOrDefaultAsync(a => a.ImageAssetUuid == imageAssetUuid, ct);
        if (asset == null)
            return NotFound(new { error = "Фото не найдено." });

        var canRead = asset.SenderUserUuid == userUuid;
        if (!canRead && asset.MessageUuid.HasValue)
        {
            canRead = await _msg.UserMessages.AsNoTracking().AnyAsync(m =>
                m.MessageUuid == asset.MessageUuid.Value &&
                (m.SenderUserUuid == userUuid || m.ReceiverUserUuid == userUuid), ct);
        }

        if (!canRead)
            return Forbid();

        Response.Headers["X-Flora-Image-Content-Type"] = asset.ContentType;
        return File(asset.EncryptedBytes, "application/octet-stream");
    }

    /// <summary>Отправить сообщение только в формате E2E (FSCP wire): encryptedForReceiver и encryptedForSender.</summary>
    [HttpPost("messages")]
    [Authorize]
    public async Task<IActionResult> SendMessage([FromBody] SendMessageRequest request, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var toUuid = request.ToUserUuid;
        if (toUuid == userUuid)
            return BadRequest(new { error = "Нельзя отправить сообщение себе." });

        var useE2E = !string.IsNullOrEmpty(request.EncryptedForReceiver) && !string.IsNullOrEmpty(request.EncryptedForSender);
        if (!useE2E)
        {
            return BadRequest(new
            {
                error = "Сообщения принимаются только с end-to-end шифрованием (поля encryptedForReceiver и encryptedForSender). Обновите клиент."
            });
        }

        var encryptedForReceiver = request.EncryptedForReceiver!.Trim();
        var encryptedForSender = request.EncryptedForSender!.Trim();
        if (string.IsNullOrEmpty(encryptedForReceiver) || string.IsNullOrEmpty(encryptedForSender))
            return BadRequest(new { error = "Для E2E нужны оба поля: encryptedForReceiver и encryptedForSender." });

        if (!FscpWireEnvelopeValidator.TryValidateDualWire(encryptedForReceiver, encryptedForSender, userUuid, toUuid, out var fscpErr))
            return BadRequest(new { error = fscpErr });

        var receiverExists = await _auth.UserAccounts.AsNoTracking().AnyAsync(a => a.UserUuid == toUuid, ct);
        if (!receiverExists)
            return NotFound(new { error = "Пользователь не найден." });
        if (!await _profileAccess.CanAccessAsync(userUuid, toUuid, ProfileAccessField.Messages, ct))
            return StatusCode(StatusCodes.Status403Forbidden, new { error = "Пользователь ограничил входящие сообщения." });
        if (await _blocklist.IsBlockedByAsync(toUuid, userUuid, ct))
            return StatusCode(StatusCodes.Status403Forbidden, new { error = "Пользователь ограничил входящие сообщения." });

        var voiceAssetUuids = (request.VoiceAssetUuids ?? Array.Empty<Guid>())
            .Where(x => x != Guid.Empty)
            .Distinct()
            .ToArray();
        var voiceAssets = new List<UserMessageVoiceAsset>();
        if (voiceAssetUuids.Length > 0)
        {
            voiceAssets = await _msg.UserMessageVoiceAssets
                .Where(a => voiceAssetUuids.Contains(a.VoiceAssetUuid))
                .ToListAsync(ct);
            if (voiceAssets.Count != voiceAssetUuids.Length)
                return BadRequest(new { error = "Одно или несколько голосовых вложений не найдены." });
            if (voiceAssets.Any(a => a.SenderUserUuid != userUuid || a.ReceiverUserUuid != toUuid || a.MessageUuid != null))
                return BadRequest(new { error = "Голосовое вложение не принадлежит этому черновику или уже отправлено." });
        }

        var msg = new UserMessage
        {
            SenderUserUuid = userUuid,
            ReceiverUserUuid = toUuid,
            Content = null,
            EncryptedForReceiver = encryptedForReceiver,
            EncryptedForSender = encryptedForSender
        };
        _msg.UserMessages.Add(msg);
        foreach (var voiceAsset in voiceAssets)
            voiceAsset.MessageUuid = msg.MessageUuid;

        var imageAssetUuids = (request.ImageAssetUuids ?? Array.Empty<Guid>())
            .Where(x => x != Guid.Empty)
            .Distinct()
            .ToArray();
        if (imageAssetUuids.Length > 0)
        {
            var imageAssets = await _msg.UserMessageImageAssets
                .Where(a => imageAssetUuids.Contains(a.ImageAssetUuid))
                .ToListAsync(ct);
            if (imageAssets.Count != imageAssetUuids.Length)
                return BadRequest(new { error = "Одно или несколько фото не найдены." });
            if (imageAssets.Any(a => a.SenderUserUuid != userUuid || a.ReceiverUserUuid != toUuid || a.MessageUuid != null))
                return BadRequest(new { error = "Фото не принадлежит этому черновику или уже отправлено." });
            foreach (var imageAsset in imageAssets)
                imageAsset.MessageUuid = msg.MessageUuid;
        }

        await SaveAllAsync(ct);

        return Ok(new { messageUuid = msg.MessageUuid, content = (string?)null, encryptedForMe = encryptedForSender, createdAt = msg.CreatedAt });
    }

    /// <summary>Удалить своё сообщение.</summary>
    [HttpDelete("messages/{messageUuid:guid}")]
    [Authorize]
    public async Task<IActionResult> DeleteMessage(Guid messageUuid, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var msg = await _msg.UserMessages.FirstOrDefaultAsync(m => m.MessageUuid == messageUuid, ct);
        if (msg == null)
            return NotFound(new { error = "Сообщение не найдено." });
        if (msg.SenderUserUuid != userUuid)
            return Forbid();

        _msg.UserMessages.Remove(msg);
        await SaveAllAsync(ct);
        return Ok(new { message = "Сообщение удалено." });
    }

    /// <summary>Персональные рекомендации пользователей для вкладки «Рекомендации».</summary>
    [HttpGet("users/recommended")]
    [Authorize]
    public async Task<IActionResult> GetRecommendedUsers([FromQuery] int take = 30, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Необходимо войти в аккаунт." });

        var list    = await _userRecommendation.GetRecommendedAsync(userUuid, take, ct);
        var userIds = list.Select(x => x.UserUuid).ToList();
        var accounts = await _auth.UserAccounts.AsNoTracking()
            .Where(a => userIds.Contains(a.UserUuid) && a.Username != null)
            .Select(a => new { a.UserUuid, a.Username })
            .ToListAsync(ct);
        var usernameByUuid = accounts.ToDictionary(x => x.UserUuid, x => x.Username!);

        var followingSet = await _users.UserFollowers.AsNoTracking()
            .Where(f => f.FollowerUserUuid == userUuid && userIds.Contains(f.FollowingUserUuid))
            .Select(f => f.FollowingUserUuid)
            .ToHashSetAsync(ct);

        var items = list
            .Where(x => usernameByUuid.ContainsKey(x.UserUuid))
            .Select(x => new
            {
                username    = usernameByUuid[x.UserUuid],
                displayName = string.IsNullOrWhiteSpace(x.DisplayName) ? usernameByUuid[x.UserUuid] : x.DisplayName,
                avatarUuid  = x.AvatarUuid?.ToString(),
                followerCount = x.FollowerCount,
                isFollowing = followingSet.Contains(x.UserUuid),
            })
            .ToList();

        var generatedAt = _userRecommendation.GetCacheGeneratedAt(userUuid) ?? DateTime.UtcNow;
        var expiresAt   = _userRecommendation.GetCacheExpiresAt(userUuid) ?? generatedAt.AddSeconds(300);
        return Ok(new { items, generatedAt, expiresAt });
    }

    /// <summary>Поиск пользователей по имени или юзернейму (для вкладки «Люди»).</summary>
    [HttpGet("users/search")]
    [Authorize]
    public async Task<IActionResult> SearchUsers([FromQuery] string? q, [FromQuery] int skip = 0, [FromQuery] int take = 20, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var currentUuid))
            return Unauthorized(new { error = "Необходимо войти в аккаунт." });
        var query = (q ?? "").Trim();
        if (query.Length < 1)
            return Ok(new List<object>());
        take = Math.Clamp(take, 1, 50);
        var lower = query.ToLower();
        var combined2 = await (
            from a in _auth.UserAccounts.AsNoTracking()
            join p in _users.UserProfiles.AsNoTracking() on a.UserUuid equals p.UserUuid into profileJoin
            from p in profileJoin.DefaultIfEmpty()
            where a.UserUuid != currentUuid
                  && a.Username != null
                  && (a.Username.ToLower().Contains(lower)
                      || (p.DisplayName != null && p.DisplayName.ToLower().Contains(lower)))
            orderby a.Username
            select new
            {
                a.UserUuid,
                a.Username,
                DisplayName = p != null ? p.DisplayName : null,
                AvatarUuid = p != null ? p.AvatarUuid : (Guid?)null,
            })
            .Skip(skip)
            .Take(take)
            .ToListAsync(ct);
        var userIds = combined2.Select(x => x.UserUuid).ToList();
        var followingSet = userIds.Count == 0
            ? new HashSet<Guid>()
            : await _users.UserFollowers.AsNoTracking()
                .Where(f => f.FollowerUserUuid == currentUuid && userIds.Contains(f.FollowingUserUuid))
                .Select(f => f.FollowingUserUuid)
                .ToHashSetAsync(ct);
        var followerCounts = await GetFollowerCountsByUserUuidAsync(userIds, ct);
        var result = combined2.Select(x => new
        {
            username = x.Username ?? "",
            displayName = x.DisplayName ?? x.Username ?? "",
            avatarUuid = x.AvatarUuid?.ToString(),
            followerCount = followerCounts.GetValueOrDefault(x.UserUuid, 0),
            isFollowing = followingSet.Contains(x.UserUuid),
        });
        return Ok(result);
    }

    /// <summary>Получить пользователя по юзернейму (для начала переписки).</summary>
    [HttpGet("users/by-username/{username}")]
    [Authorize]
    public async Task<IActionResult> GetUserByUsername(string username, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var currentUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var normalized = NormalizeUsername(username);
        if (string.IsNullOrEmpty(normalized))
            return BadRequest(new { error = "Укажите юзернейм." });
        var account = await _auth.UserAccounts.AsNoTracking().FirstOrDefaultAsync(u => u.Username == normalized, ct);
        if (account == null)
            return NotFound(new { error = "Пользователь не найден." });
        if (account.UserUuid == currentUuid)
            return BadRequest(new { error = "Нельзя начать переписку с собой." });
        var profile = await _users.UserProfiles.AsNoTracking().FirstOrDefaultAsync(p => p.UserUuid == account.UserUuid, ct);
        return Ok(new
        {
            userUuid = account.UserUuid,
            username = account.Username ?? "",
            displayName = profile?.DisplayName ?? account.Username ?? "",
            avatarUuid = profile?.AvatarUuid?.ToString()
        });
    }

    /// <summary>Отметить сообщения от пользователя как прочитанные.</summary>
    [HttpPatch("conversations/with/{otherUserUuid:guid}/read")]
    [Authorize]
    public async Task<IActionResult> MarkConversationRead(Guid otherUserUuid, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var toUpdate = await _msg.UserMessages
            .Where(m => m.SenderUserUuid == otherUserUuid && m.ReceiverUserUuid == userUuid && !m.IsRead)
            .ToListAsync(ct);
        foreach (var m in toUpdate)
            m.IsRead = true;
        await SaveAllAsync(ct);
        return NoContent();
    }

    /// <summary>Удалить диалог с пользователем (все сообщения между вами).</summary>
    [HttpDelete("conversations/with/{otherUserUuid:guid}")]
    [Authorize]
    public async Task<IActionResult> DeleteConversation(Guid otherUserUuid, CancellationToken ct = default)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(sub) || !Guid.TryParse(sub, out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        if (otherUserUuid == userUuid)
            return BadRequest(new { error = "Нельзя удалить диалог с самим собой." });

        // Scoped to the caller's own conversation (no cross-account authz escape), but note an
        // accepted MVP limitation documented in SECURITY.md: UserMessage rows are shared between both
        // participants (single row carries EncryptedForSender + EncryptedForReceiver), so this hard
        // delete also removes the conversation from the other party's view. Per-side ("delete for me")
        // deletion is a deferred schema change (per-side soft-delete flags + filtered reads).
        var toDelete = await _msg.UserMessages
            .Where(m => (m.SenderUserUuid == userUuid && m.ReceiverUserUuid == otherUserUuid) ||
                        (m.SenderUserUuid == otherUserUuid && m.ReceiverUserUuid == userUuid))
            .ToListAsync(ct);
        _msg.UserMessages.RemoveRange(toDelete);
        await SaveAllAsync(ct);
        return NoContent();
    }

    private static string NormalizeSlug(string? raw) => LatinIdentifiers.NormalizeSlug(raw);

    /// <summary>True, если в user_profiles нет строки display_name или она пустая (нужен шаг «Имя» на клиенте).</summary>
    private async Task<bool> RequiresProfileCompletionAsync(Guid userUuid, CancellationToken cancellationToken)
    {
        var profile = await _users.UserProfiles.AsNoTracking()
            .FirstOrDefaultAsync(p => p.UserUuid == userUuid, cancellationToken);
        return profile == null || string.IsNullOrWhiteSpace(profile.DisplayName);
    }

    /// <summary>Юзернейм: латиница, цифры, подчёркивание; @ в начале убирается.</summary>
    private static string NormalizeUsername(string? raw) => LatinIdentifiers.NormalizeUsername(raw);

    private async Task<Guid?> ResolveProfileUserUuidAsync(string username, CancellationToken ct)
    {
        var normalized = NormalizeUsername(username);
        if (string.IsNullOrEmpty(normalized))
            return null;
        var account = await FindUserAccountByUsernameAsync(normalized, ct);
        return account?.UserUuid;
    }

    private async Task<UserAccount?> FindUserAccountByUsernameAsync(string normalized, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(normalized))
            return null;
        var key = normalized.ToLowerInvariant();
        var account = await _auth.UserAccounts.AsNoTracking()
            .FirstOrDefaultAsync(u => u.Username != null && u.Username.ToLower() == key, ct);
        if (account is null)
            return null;
        if (TryGetCurrentUserUuid(out var viewerUuid) &&
            viewerUuid != account.UserUuid &&
            await _blocklist.IsBlockedByAsync(account.UserUuid, viewerUuid, ct))
        {
            return null;
        }
        return account;
    }

    private async Task<IActionResult> BuildProfilePostsPayloadAsync(
        List<ProfilePostRow> posts,
        Guid? currentUserUuid,
        CancellationToken ct)
    {
        if (posts.Count == 0)
            return Ok(Array.Empty<object>());

        var postUuids = posts.Select(p => p.PostUuid).ToList();
        var commentCounts = await _content.PostComments.AsNoTracking()
            .Where(c => postUuids.Contains(c.PostUuid) && !c.IsDeleted)
            .GroupBy(c => c.PostUuid)
            .Select(g => new { PostUuid = g.Key, Count = g.Count() })
            .ToListAsync(ct);
        var likeCounts = await _content.PostLikes.AsNoTracking()
            .Where(l => postUuids.Contains(l.PostUuid))
            .GroupBy(l => l.PostUuid)
            .Select(g => new { PostUuid = g.Key, Count = g.Count() })
            .ToListAsync(ct);
        var repostCounts = await _content.PostReposts.AsNoTracking()
            .Where(r => postUuids.Contains(r.PostUuid))
            .GroupBy(r => r.PostUuid)
            .Select(g => new { PostUuid = g.Key, Count = g.Count() })
            .ToListAsync(ct);
        var viewCounts = await _content.PostViews.AsNoTracking()
            .Where(v => postUuids.Contains(v.PostUuid))
            .GroupBy(v => v.PostUuid)
            .Select(g => new { PostUuid = g.Key, Count = g.Count() })
            .ToListAsync(ct);
        var commentDict = commentCounts.ToDictionary(x => x.PostUuid, x => x.Count);
        var likeDict = likeCounts.ToDictionary(x => x.PostUuid, x => x.Count);
        var repostDict = repostCounts.ToDictionary(x => x.PostUuid, x => x.Count);
        var viewDict = viewCounts.ToDictionary(x => x.PostUuid, x => x.Count);

        HashSet<Guid>? likedPostIds = null;
        HashSet<Guid>? repostedPostIds = null;
        HashSet<Guid>? commentedPostIds = null;
        if (currentUserUuid.HasValue)
        {
            var uid = currentUserUuid.Value;
            likedPostIds = (await _content.PostLikes.AsNoTracking()
                .Where(l => l.UserUuid == uid && postUuids.Contains(l.PostUuid))
                .Select(l => l.PostUuid)
                .ToListAsync(ct)).ToHashSet();
            repostedPostIds = (await _content.PostReposts.AsNoTracking()
                .Where(r => r.UserUuid == uid && postUuids.Contains(r.PostUuid))
                .Select(r => r.PostUuid)
                .ToListAsync(ct)).ToHashSet();
            commentedPostIds = (await _content.PostComments.AsNoTracking()
                .Where(c => c.AuthorUserUuid == uid && postUuids.Contains(c.PostUuid) && !c.IsDeleted)
                .Select(c => c.PostUuid)
                .Distinct()
                .ToListAsync(ct)).ToHashSet();
        }

        var postImagesProfile = await _content.PostImages.AsNoTracking()
            .Where(i => postUuids.Contains(i.PostUuid))
            .OrderBy(i => i.PostUuid).ThenBy(i => i.SortOrder)
            .Select(i => new { i.PostUuid, i.Uuid })
            .ToListAsync(ct);
        var imagesByPostProfile = postImagesProfile
            .GroupBy(i => i.PostUuid)
            .ToDictionary(g => g.Key, g => g.Select(x => x.Uuid).ToList());
        var videosByPostLiked = await GetPostVideosByPostAsync(postUuids, ct);

        var result = posts.Select(p => new
        {
            postUuid = p.PostUuid,
            content = p.Content,
            createdAt = p.CreatedAt,
            imageUuids = imagesByPostProfile.GetValueOrDefault(p.PostUuid, new List<Guid>()),
            video = videosByPostLiked.GetValueOrDefault(p.PostUuid),
            commentsCount = commentDict.GetValueOrDefault(p.PostUuid, 0),
            likesCount = likeDict.GetValueOrDefault(p.PostUuid, 0),
            repostsCount = repostDict.GetValueOrDefault(p.PostUuid, 0),
            viewsCount = viewDict.GetValueOrDefault(p.PostUuid, 0),
            liked = likedPostIds?.Contains(p.PostUuid) ?? false,
            reposted = repostedPostIds?.Contains(p.PostUuid) ?? false,
            hasCommented = commentedPostIds?.Contains(p.PostUuid) ?? false,
        });
        return Ok(result);
    }

    private sealed record ProfilePostRow(Guid PostUuid, string Content, DateTime CreatedAt);

    private bool TryGetCurrentUserUuid(out Guid userUuid)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (!string.IsNullOrEmpty(sub) && Guid.TryParse(sub, out userUuid))
            return true;
        userUuid = Guid.Empty;
        return false;
    }

    private static bool IsWeakUsername(string normalized) =>
        string.IsNullOrWhiteSpace(normalized) || normalized.Length < 2 || normalized.All(c => c == '_');

    private (string Ip, string AgentHash) GetRequestContext()
    {
        var ip = HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        if (ip.Length > 45) ip = ip[..45];
        var agent = HttpContext.Request.Headers.UserAgent.ToString();
        var agentHash = Convert.ToBase64String(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(agent)));
        if (agentHash.Length > 64) agentHash = agentHash[..64];
        return (ip, agentHash);
    }

    private async Task<(string Label, string Username)> ResolveActorPresentationAsync(Guid actorUserUuid, CancellationToken ct)
    {
        var account = await _auth.UserAccounts.AsNoTracking().FirstOrDefaultAsync(a => a.UserUuid == actorUserUuid, ct);
        var profile = await _users.UserProfiles.AsNoTracking().FirstOrDefaultAsync(p => p.UserUuid == actorUserUuid, ct);
        var username = account?.Username ?? "";
        var displayName = profile?.DisplayName?.Trim();
        var label = !string.IsNullOrEmpty(displayName) ? displayName : (username.Length > 0 ? $"@{username}" : "Пользователь");
        return (label, username);
    }

    private async Task TryNotifyLikeAsync(Guid actorUserUuid, Guid postUuid, CancellationToken ct)
    {
        try
        {
            var post = await _content.UserPosts.AsNoTracking()
                .FirstOrDefaultAsync(p => p.PostUuid == postUuid && !p.IsDeleted, ct);
            if (post is null || post.AuthorUserUuid == actorUserUuid) return;
            var (label, _) = await ResolveActorPresentationAsync(actorUserUuid, ct);
            await _notifications.DispatchAsync(new CreateUserNotificationCommand(
                post.AuthorUserUuid,
                actorUserUuid,
                "like",
                "social",
                $"{label} оценил ваш пост",
                postUuid), ct);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Не удалось создать уведомление о лайке поста {PostUuid}", postUuid);
        }
    }

    private async Task TryNotifyCommentAsync(
        Guid actorUserUuid,
        UserPost post,
        PostComment comment,
        Guid? parentCommentUuid,
        CancellationToken ct)
    {
        try
        {
            var (label, _) = await ResolveActorPresentationAsync(actorUserUuid, ct);
            var recipients = new HashSet<Guid>();
            if (post.AuthorUserUuid != actorUserUuid)
                recipients.Add(post.AuthorUserUuid);
            if (parentCommentUuid is Guid parentUuid)
            {
                var parent = await _content.PostComments.AsNoTracking()
                    .FirstOrDefaultAsync(c => c.CommentUuid == parentUuid && !c.IsDeleted, ct);
                if (parent is not null && parent.AuthorUserUuid != actorUserUuid)
                    recipients.Add(parent.AuthorUserUuid);
            }

            foreach (var recipient in recipients)
            {
                var text = parentCommentUuid is not null
                    ? $"{label} ответил(а) в обсуждении"
                    : $"{label} прокомментировал(а) ваш пост";
                await _notifications.DispatchAsync(new CreateUserNotificationCommand(
                    recipient,
                    actorUserUuid,
                    "reply",
                    "social",
                    text,
                    post.PostUuid,
                    comment.CommentUuid), ct);
            }
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Не удалось создать уведомление о комментарии к посту {PostUuid}", post.PostUuid);
        }
    }

    private async Task TryNotifyFollowAsync(Guid followerUuid, Guid followingUuid, string followerUsername, CancellationToken ct)
    {
        try
        {
            var (label, username) = await ResolveActorPresentationAsync(followerUuid, ct);
            var handle = username.Length > 0 ? $"@{username}" : label;
            await _notifications.DispatchAsync(new CreateUserNotificationCommand(
                followingUuid,
                followerUuid,
                "follow",
                "social",
                $"Новый подписчик {handle}"), ct);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Не удалось создать уведомление о подписке {Follower} → {Following}", followerUsername, followingUuid);
        }
    }

    private async Task SaveAllAsync(CancellationToken ct)
    {
        await _auth.SaveChangesAsync(ct);
        await _users.SaveChangesAsync(ct);
        await _content.SaveChangesAsync(ct);
        await _msg.SaveChangesAsync(ct);
    }

    private async Task<Dictionary<Guid, int>> GetFollowerCountsByUserUuidAsync(
        IReadOnlyCollection<Guid> userUuids,
        CancellationToken ct)
    {
        if (userUuids.Count == 0)
            return new Dictionary<Guid, int>();
        var rows = await _users.UserFollowers.AsNoTracking()
            .Where(f => userUuids.Contains(f.FollowingUserUuid))
            .GroupBy(f => f.FollowingUserUuid)
            .Select(g => new { UserUuid = g.Key, Count = g.Count() })
            .ToListAsync(ct);
        return rows.ToDictionary(x => x.UserUuid, x => x.Count);
    }

    /// <summary>Нормализация телефона: только цифры и +, не более 20 символов.</summary>
    private static string NormalizePhone(string phone)
    {
        if (string.IsNullOrWhiteSpace(phone)) return "";
        var digits = new string(phone.Where(c => char.IsDigit(c) || c == '+').ToArray());
        return digits.Length > 20 ? digits[..20] : digits;
    }

    private static string ResolveIdentifier(string? email, string? phone)
    {
        var normalizedEmail = (email ?? "").Trim().ToLowerInvariant();
        if (!string.IsNullOrWhiteSpace(normalizedEmail)) return normalizedEmail;
        return (phone ?? "").Trim();
    }
}
