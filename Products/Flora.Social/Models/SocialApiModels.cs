using System.Text.Json.Serialization;

namespace Flora.Social.Models;

public record LoginRequest(string? Phone, string? Email, string Password, string? TwoFactorCode = null);
public record RegisterRequest(string? Phone, string? Email, string Password);
public record VerifyRegistrationRequest(string VerificationToken, string Code);
public record CancelRegistrationRequest(string VerificationToken);
public record RefreshRequest(string RefreshToken);
public record LoginResponse(
    string AccessToken,
    string RefreshToken,
    DateTime ExpiresAt,
    string TokenType = "Bearer",
    bool RequiresProfileCompletion = false);
public record RegisterInitResponse(
    string VerificationToken,
    DateTime ExpiresAt,
    string? DevVerificationCode = null);

public record UpdateProfileRequest(
    string? Username,
    string? DisplayName,
    int? Gender,
    string? BirthDate,
    string? Status);

public record ChangePasswordRequest(string? CurrentPassword, string? NewPassword);
public record BeginEmailChangeRequest(string? Password, string? NewEmail);
public record ConfirmEmailChangeRequest(string? ChangeToken, string? Code);
public record ChangePhoneRequest(string? Password, string? Phone);
public record TwoFactorPasswordRequest(string? Password);
public record TwoFactorCodeRequest(string? Code);
public record DisableTwoFactorRequest(string? Password, string? Code);
public record DeleteAccountRequest(string? Password, string? TwoFactorCode = null);

public record CreatePostRequest(string? Content, Guid? CommunityId = null);
public record CreatePostDraftRequest(string? Label, string? Content, Guid? CommunityId = null);
public record UpdatePostDraftRequest(string? Label, string? Content);
public record CreateCommentRequest(string? Content, Guid? ParentCommentUuid = null);

public class CreateCommunityRequest
{
    public string? Name { get; set; }
    public string? Slug { get; set; }
    public bool? IsPrivate { get; set; }
}

public class UpdateCommunityRequest
{
    public string? Name { get; set; }
    public string? Slug { get; set; }
    public bool? IsPrivate { get; set; }
}

public record SendMessageRequest(
    Guid ToUserUuid,
    string? Content,
    string? EncryptedForReceiver,
    string? EncryptedForSender,
    Guid[]? VoiceAssetUuids = null,
    Guid[]? ImageAssetUuids = null);

public class SetE2EPublicKeyRequest
{
    [JsonPropertyName("publicKeyBase64")]
    public string? PublicKeyBase64 { get; set; }

    /// <summary>FSCP: стабильный идентификатор устройства (UUID). Если не передан — сервер сгенерирует при первой регистрации.</summary>
    [JsonPropertyName("deviceUuid")]
    public string? DeviceUuid { get; set; }
}
