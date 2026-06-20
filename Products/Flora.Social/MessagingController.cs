using System.Text.Json;
using System.Security.Claims;
using Flora.Auth.Infrastructure;
using Flora.Messaging;
using Flora.Messaging.Application;
using Flora.Messaging.Contracts;
using Flora.Messaging.Domain;
using Flora.Messaging.Infrastructure;
using Flora.Shared;
using Flora.Users.Contracts;
using Flora.Users.Infrastructure;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;

namespace Flora.Social;

/// <summary>
/// FSCP-compliant messaging API: conversations and messages under /api/messaging.
/// Routing follows docs/fscp/e2e-security.md §API contracts (Messages section).
/// Business logic lives in <see cref="IConversationService"/> / <see cref="IE2EKeyBackupService"/>;
/// user-profile enrichment (names, avatars) is done here as a bridge-phase query
/// until Auth/Users modules expose dedicated gRPC endpoints.
/// </summary>
[ApiController]
[Route("api/messaging")]
[Authorize]
public sealed class MessagingController(
    IConversationService conversations,
    IE2EKeyBackupService keyBackup,
    IE2EEpochService epochs,
    IProfileAccessPolicy profileAccess,
    IUserBlocklistService blocklist,
    IUserPresenceService presence,
    AuthDbContext auth,
    UsersDbContext users,
    MessagingDbContext messagingDb) : ControllerBase
{
    private const long MaxMessageImageBytes = 5L * 1024 * 1024;
    // Синхронно с Apps/Web lib/messageVideos.ts (клиентское сжатие + накладные расходы AES-GCM).
    private const long MaxMessageVideoBytes = 36L * 1024 * 1024;
    // Синхронно с Apps/Web voiceCapture.ts и Apps/Mobile lib/voiceLimits.ts.
    private const int MaxVoiceAssetDurationMs = 30 * 60 * 1000;
    private const long MaxVoiceAssetBytes = 14L * 1024 * 1024;

    private static readonly JsonSerializerOptions MessagePostJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    // ── Auth helper ──────────────────────────────────────────────────────────

    private bool TryGetCurrentUser(out Guid userUuid)
    {
        var sub = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (!string.IsNullOrEmpty(sub) && Guid.TryParse(sub, out userUuid))
            return true;
        userUuid = Guid.Empty;
        return false;
    }

    // ── GET /api/messaging/unread-count — число чатов с непрочитанным, не сообщений ──

    [HttpGet("unread-count")]
    public async Task<IActionResult> GetUnreadCount(CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var myUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var count = await conversations.GetTotalUnreadCountAsync(myUuid, ct);
        return Ok(new { unreadCount = count });
    }

    // ── GET /api/messaging/conversations ────────────────────────────────────

    /// <summary>
    /// Cursor-paged conversation list. Returns at most <paramref name="take"/> items,
    /// newest last-message first. Each item includes the peer's public profile and
    /// the last message ciphertext for client-side decryption.
    /// </summary>
    [HttpGet("conversations")]
    public async Task<IActionResult> GetConversations(
        [FromQuery] string? cursor,
        [FromQuery] int take = 20,
        CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var myUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        await presence.TouchAsync(myUuid, ct);

        take = Math.Clamp(take, 1, 100);
        var page = await conversations.GetConversationsAsync(myUuid, cursor, take, ct);

        if (page.Items.Count == 0)
            return Ok(new { items = Array.Empty<object>(), nextCursor = (string?)null, hasMore = false });

        var otherUuids = page.Items.Select(i => i.OtherUserUuid).ToList();
        var lastSeenMap = await presence.GetLastSeenUtcByUserUuidsAsync(otherUuids, ct);
        var utcNow = DateTime.UtcNow;

        var accounts = await auth.UserAccounts.AsNoTracking()
            .Where(a => otherUuids.Contains(a.UserUuid))
            .Select(a => new { a.UserUuid, a.Username })
            .ToListAsync(ct);

        var profiles = await users.UserProfiles.AsNoTracking()
            .Where(p => otherUuids.Contains(p.UserUuid))
            .Select(p => new { p.UserUuid, p.DisplayName, p.AvatarUuid })
            .ToListAsync(ct);

        var accByUuid = accounts.ToDictionary(a => a.UserUuid);
        var profByUuid = profiles.ToDictionary(p => p.UserUuid);

        var items = new List<object>(page.Items.Count);
        foreach (var item in page.Items)
        {
            var acc = accByUuid.GetValueOrDefault(item.OtherUserUuid);
            var prof = profByUuid.GetValueOrDefault(item.OtherUserUuid);
            var canSeeOnline = await profileAccess.CanAccessAsync(
                myUuid, item.OtherUserUuid, ProfileAccessField.OnlineStatus, ct);
            var (otherUserIsOnline, otherUserLastSeenAt) = UserOnlineStatusHelper.ResolveForViewer(
                myUuid, item.OtherUserUuid, canSeeOnline, lastSeenMap, utcNow);
            items.Add(new
            {
                conversationUuid = item.ConversationUuid,
                otherUserUuid = item.OtherUserUuid,
                otherUsername = acc?.Username ?? "",
                otherDisplayName = prof?.DisplayName ?? acc?.Username ?? "",
                otherAvatarUuid = prof?.AvatarUuid?.ToString(),
                lastMessageEncryptedForMe = item.LastMessageEncryptedForMe,
                lastMessageContent = item.LastMessageContent,
                lastMessageAt = item.LastMessageAt,
                lastMessageIsFromMe = item.LastMessageIsFromMe,
                unreadCount = item.UnreadCount,
                otherUserIsOnline,
                otherUserLastSeenAt,
            });
        }

        return Ok(new { items, nextCursor = page.NextCursor, hasMore = page.HasMore });
    }

    // ── GET /api/messaging/conversations/{conversationUuid}/messages ─────────

    /// <summary>
    /// Cursor-paged messages for a specific conversation (identified by deterministic
    /// conversationUuid = UuidV5(min(A,B), max(A,B), "fscp-dm-v1")).
    /// Returns 404 if the conversation cannot be resolved.
    /// Pass <paramref name="otherUserUuid"/> to open an empty DM before the first message.
    /// </summary>
    [HttpGet("conversations/{conversationUuid:guid}/messages")]
    public async Task<IActionResult> GetMessages(
        Guid conversationUuid,
        [FromQuery] Guid? otherUserUuid,
        [FromQuery] string? cursor,
        [FromQuery] int take = 50,
        CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var myUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        take = Math.Clamp(take, 1, 100);
        var page = await conversations.GetMessagesAsync(
            myUuid, conversationUuid, otherUserUuid, cursor, take, ct);
        if (page is null)
            return NotFound(new { error = "Разговор не найден." });

        var items = page.Items.Select(m => new
        {
            messageUuid = m.MessageUuid,
            senderUserUuid = m.SenderUserUuid,
            encryptedForMe = m.EncryptedForMe,
            content = m.Content,
            createdAt = m.CreatedAt,
            isRead = m.IsRead,
            isFromMe = m.IsFromMe,
            voiceAssetUuids = m.VoiceAssetUuids,
            imageAssetUuids = m.ImageAssetUuids,
            videoAssetUuids = m.VideoAssetUuids,
        }).ToList();

        return Ok(new { items, nextCursor = page.NextCursor, hasMore = page.HasMore });
    }

    // ── POST /api/messaging/conversations/{conversationUuid}/messages ─────────

    /// <summary>
    /// Send an E2E-encrypted message.
    /// Both <c>encryptedForReceiver</c> and <c>encryptedForSender</c> are required and
    /// must be identical FSCP v1 wires (spec: dual-wire bootstrap model).
    /// The receiver UUID is extracted from the FSCP wire (validated by
    /// <see cref="FscpWireEnvelopeValidator.TryValidateDualWire"/>).
    /// </summary>
    [HttpPost("conversations/{conversationUuid:guid}/messages")]
    public async Task<IActionResult> PostMessage(
        Guid conversationUuid,
        [FromBody] JsonElement body,
        CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var myUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var request = body.Deserialize<PostConversationMessageRequest>(MessagePostJson);
        if (request is null)
            return BadRequest(new { error = "Некорректное тело запроса." });

        if (string.IsNullOrWhiteSpace(request.EncryptedForReceiver) ||
            string.IsNullOrWhiteSpace(request.EncryptedForSender))
            return BadRequest(new { error = "Поля encryptedForReceiver и encryptedForSender обязательны." });

        // Resolve the other participant from the FSCP wire.
        // The wire contains conversationUuid and receiver fields validated server-side.
        // FscpWireEnvelopeValidator extracts the receiver and checks that
        // UuidV5.DmConversationUuid(sender, receiver) == conversationUuid.
        if (!FscpWireEnvelopeValidator.TryExtractReceiver(
                request.EncryptedForReceiver, myUuid, out var receiverUuid, out var fscpErr))
            return BadRequest(new { error = fscpErr });

        var expectedConvUuid = UuidV5.DmConversationUuid(myUuid, receiverUuid);
        if (expectedConvUuid != conversationUuid)
            return BadRequest(new { error = "conversationUuid в пути не совпадает с участниками FSCP wire." });

        if (!FscpWireEnvelopeValidator.TryValidateDualWire(
                request.EncryptedForReceiver, request.EncryptedForSender,
                myUuid, receiverUuid, out fscpErr))
            return BadRequest(new { error = fscpErr });

        // Verify receiver exists.
        var receiverExists = await auth.UserAccounts.AsNoTracking()
            .AnyAsync(a => a.UserUuid == receiverUuid, ct);
        if (!receiverExists)
            return NotFound(new { error = "Получатель не найден." });

        if (!await profileAccess.CanAccessAsync(myUuid, receiverUuid, ProfileAccessField.Messages, ct))
            return StatusCode(StatusCodes.Status403Forbidden, new { error = "Пользователь ограничил входящие сообщения." });

        if (await blocklist.IsBlockedByAsync(receiverUuid, myUuid, ct))
            return StatusCode(StatusCodes.Status403Forbidden, new { error = "Пользователь ограничил входящие сообщения." });

        // Validate and link voice assets.
        var voiceUuids = (request.VoiceAssetUuids ?? [])
            .Where(x => x != Guid.Empty)
            .Distinct()
            .ToList();

        var imageUuids = (request.ImageAssetUuids ?? [])
            .Where(x => x != Guid.Empty)
            .Distinct()
            .ToList();

        var videoUuids = (request.VideoAssetUuids ?? [])
            .Where(x => x != Guid.Empty)
            .Distinct()
            .ToList();

        var pushPreviewRaw = request.PushPreview;
        if (string.IsNullOrWhiteSpace(pushPreviewRaw) &&
            body.TryGetProperty("pushPreview", out var previewEl) &&
            previewEl.ValueKind == JsonValueKind.String)
        {
            pushPreviewRaw = previewEl.GetString();
        }

        if (voiceUuids.Count > 0)
        {
            var voiceAssets = await messagingDb.UserMessageVoiceAssets
                .Where(a => voiceUuids.Contains(a.VoiceAssetUuid))
                .ToListAsync(ct);
            if (voiceAssets.Count != voiceUuids.Count)
                return BadRequest(new { error = "Одно или несколько голосовых вложений не найдены." });
            if (voiceAssets.Any(a =>
                    a.SenderUserUuid != myUuid ||
                    a.ReceiverUserUuid != receiverUuid ||
                    a.MessageUuid != null))
                return BadRequest(new { error = "Голосовое вложение не принадлежит этому черновику или уже отправлено." });
        }

        var pushContext = MessageSentPushContext.FromRequest(
            pushPreviewRaw,
            voiceUuids.Count > 0,
            imageUuids.Count > 0,
            videoUuids.Count > 0);

        var result = await conversations.SendMessageDirectAsync(
            myUuid, receiverUuid,
            request.EncryptedForReceiver, request.EncryptedForSender,
            voiceUuids, imageUuids, videoUuids, pushContext, ct);

        return Ok(new
        {
            messageUuid = result.MessageUuid,
            createdAt = result.CreatedAt,
            encryptedForMe = result.EncryptedForSender,
        });
    }

    // ── DELETE /api/messaging/conversations/{conversationUuid}/messages/{messageUuid} ─

    /// <summary>Удалить своё сообщение (hard delete для обоих участников).</summary>
    [HttpDelete("conversations/{conversationUuid:guid}/messages/{messageUuid:guid}")]
    public async Task<IActionResult> DeleteMessage(
        Guid conversationUuid,
        Guid messageUuid,
        CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var myUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var result = await conversations.DeleteMessageAsync(myUuid, conversationUuid, messageUuid, ct);
        return result switch
        {
            DeleteMessageResult.NotFound => NotFound(new { error = "Сообщение не найдено." }),
            DeleteMessageResult.Forbidden => StatusCode(StatusCodes.Status403Forbidden, new { error = "Можно удалить только своё сообщение." }),
            _ => Ok(new { message = "Сообщение удалено." }),
        };
    }

    // ── POST /api/messaging/image-assets ─────────────────────────────────────

    /// <summary>Upload an E2E-encrypted image blob for a DM (opaque bytes on server).</summary>
    [HttpPost("image-assets")]
    [RequestSizeLimit(MaxMessageImageBytes + 1024 * 1024)]
    public async Task<IActionResult> UploadImageAsset(
        [FromForm] Guid toUserUuid,
        [FromForm] string? contentType,
        [FromForm] IFormFile? file,
        CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        if (toUserUuid == userUuid)
            return BadRequest(new { error = "Нельзя отправить фото себе." });
        if (file == null || file.Length <= 0)
            return BadRequest(new { error = "Файл фото пуст." });
        if (file.Length > MaxMessageImageBytes)
            return BadRequest(new { error = "Фото слишком большое." });

        var receiverExists = await auth.UserAccounts.AsNoTracking().AnyAsync(a => a.UserUuid == toUserUuid, ct);
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
        messagingDb.UserMessageImageAssets.Add(asset);
        await messagingDb.SaveChangesAsync(ct);

        return Ok(new
        {
            imageAssetUuid = asset.ImageAssetUuid,
            contentType = asset.ContentType
        });
    }

    // ── GET /api/messaging/image-assets/{imageAssetUuid} ─────────────────────

    /// <summary>Download an E2E-encrypted image blob for a conversation participant.</summary>
    [HttpGet("image-assets/{imageAssetUuid:guid}")]
    public async Task<IActionResult> GetImageAsset(Guid imageAssetUuid, CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var asset = await messagingDb.UserMessageImageAssets.AsNoTracking()
            .FirstOrDefaultAsync(a => a.ImageAssetUuid == imageAssetUuid, ct);
        if (asset == null)
            return NotFound(new { error = "Фото не найдено." });

        var canRead = asset.SenderUserUuid == userUuid || asset.ReceiverUserUuid == userUuid;
        if (!canRead && asset.MessageUuid.HasValue)
        {
            canRead = await messagingDb.UserMessages.AsNoTracking().AnyAsync(m =>
                m.MessageUuid == asset.MessageUuid.Value &&
                (m.SenderUserUuid == userUuid || m.ReceiverUserUuid == userUuid), ct);
        }

        if (!canRead)
            return Forbid();

        Response.Headers["X-Flora-Image-Content-Type"] = asset.ContentType;
        return File(asset.EncryptedBytes, "application/octet-stream");
    }

    // ── POST /api/messaging/video-assets ─────────────────────────────────────

    /// <summary>Upload an E2E-encrypted video blob for a DM (opaque bytes on server).</summary>
    [HttpPost("video-assets")]
    [RequestSizeLimit(MaxMessageVideoBytes + 1024 * 1024)]
    public async Task<IActionResult> UploadVideoAsset(
        [FromForm] Guid toUserUuid,
        [FromForm] string? contentType,
        [FromForm] int durationMs,
        [FromForm] IFormFile? file,
        CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        if (toUserUuid == userUuid)
            return BadRequest(new { error = "Нельзя отправить видео себе." });
        if (file == null || file.Length <= 0)
            return BadRequest(new { error = "Файл видео пуст." });
        if (file.Length > MaxMessageVideoBytes)
            return BadRequest(new { error = "Видео слишком большое." });

        var receiverExists = await auth.UserAccounts.AsNoTracking().AnyAsync(a => a.UserUuid == toUserUuid, ct);
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

        var asset = new UserMessageVideoAsset
        {
            SenderUserUuid = userUuid,
            ReceiverUserUuid = toUserUuid,
            ContentType = storedContentType,
            DurationMs = Math.Max(0, durationMs),
            EncryptedBytes = ms.ToArray()
        };
        messagingDb.UserMessageVideoAssets.Add(asset);
        await messagingDb.SaveChangesAsync(ct);

        return Ok(new
        {
            videoAssetUuid = asset.VideoAssetUuid,
            contentType = asset.ContentType
        });
    }

    // ── GET /api/messaging/video-assets/{videoAssetUuid} ─────────────────────

    /// <summary>Download an E2E-encrypted video blob for a conversation participant.</summary>
    [HttpGet("video-assets/{videoAssetUuid:guid}")]
    public async Task<IActionResult> GetVideoAsset(Guid videoAssetUuid, CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var asset = await messagingDb.UserMessageVideoAssets.AsNoTracking()
            .FirstOrDefaultAsync(a => a.VideoAssetUuid == videoAssetUuid, ct);
        if (asset == null)
            return NotFound(new { error = "Видео не найдено." });

        var canRead = asset.SenderUserUuid == userUuid;
        if (!canRead && asset.MessageUuid.HasValue)
        {
            canRead = await messagingDb.UserMessages.AsNoTracking().AnyAsync(m =>
                m.MessageUuid == asset.MessageUuid.Value &&
                (m.SenderUserUuid == userUuid || m.ReceiverUserUuid == userUuid), ct);
        }

        if (!canRead)
            return Forbid();

        Response.Headers["X-Flora-Video-Content-Type"] = asset.ContentType;
        return File(asset.EncryptedBytes, "application/octet-stream");
    }

    // ── POST /api/messaging/voice-assets ─────────────────────────────────────

    /// <summary>Upload an E2E-encrypted voice blob for a DM (opaque bytes on server).</summary>
    [HttpPost("voice-assets")]
    [RequestSizeLimit(MaxVoiceAssetBytes + 1024 * 1024)]
    public async Task<IActionResult> UploadVoiceAsset(
        [FromForm] Guid toUserUuid,
        [FromForm] int durationMs,
        [FromForm] IFormFile? file,
        CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        if (toUserUuid == userUuid)
            return BadRequest(new { error = "Нельзя отправить голосовое себе." });
        if (durationMs <= 0 || durationMs > MaxVoiceAssetDurationMs)
            return BadRequest(new { error = "Недопустимая длительность голосового сообщения." });
        if (file == null || file.Length <= 0)
            return BadRequest(new { error = "Файл голосового сообщения пуст." });
        if (file.Length > MaxVoiceAssetBytes)
            return BadRequest(new { error = "Голосовое сообщение слишком большое." });

        var receiverExists = await auth.UserAccounts.AsNoTracking().AnyAsync(a => a.UserUuid == toUserUuid, ct);
        if (!receiverExists)
            return NotFound(new { error = "Пользователь не найден." });

        await using var stream = file.OpenReadStream();
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms, ct);

        var storedContentType = file.ContentType?.Split(';')[0].Trim();
        if (string.IsNullOrWhiteSpace(storedContentType))
            storedContentType = "application/octet-stream";

        var asset = new UserMessageVoiceAsset
        {
            SenderUserUuid = userUuid,
            ReceiverUserUuid = toUserUuid,
            ContentType = storedContentType,
            DurationMs = durationMs,
            EncryptedBytes = ms.ToArray()
        };
        messagingDb.UserMessageVoiceAssets.Add(asset);
        await messagingDb.SaveChangesAsync(ct);

        return Ok(new
        {
            voiceAssetUuid = asset.VoiceAssetUuid,
            contentType = asset.ContentType,
            durationMs = asset.DurationMs
        });
    }

    // ── GET /api/messaging/voice-assets/{voiceAssetUuid} ─────────────────────

    /// <summary>Download an E2E-encrypted voice blob for a conversation participant.</summary>
    [HttpGet("voice-assets/{voiceAssetUuid:guid}")]
    public async Task<IActionResult> GetVoiceAsset(Guid voiceAssetUuid, CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var userUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var asset = await messagingDb.UserMessageVoiceAssets.AsNoTracking()
            .FirstOrDefaultAsync(a => a.VoiceAssetUuid == voiceAssetUuid, ct);
        if (asset == null)
            return NotFound(new { error = "Голосовое сообщение не найдено." });

        var canRead = asset.SenderUserUuid == userUuid || asset.ReceiverUserUuid == userUuid;
        if (!canRead && asset.MessageUuid.HasValue)
        {
            canRead = await messagingDb.UserMessages.AsNoTracking().AnyAsync(m =>
                m.MessageUuid == asset.MessageUuid.Value &&
                (m.SenderUserUuid == userUuid || m.ReceiverUserUuid == userUuid), ct);
        }

        if (!canRead)
            return Forbid();

        Response.Headers["X-Flora-Voice-Duration-Ms"] = asset.DurationMs.ToString();
        Response.Headers["X-Flora-Voice-Content-Type"] = asset.ContentType;
        return File(asset.EncryptedBytes, "application/octet-stream");
    }

    // ── POST /api/messaging/conversations/{conversationUuid}/read ────────────

    /// <summary>Marks all incoming messages in the conversation as read.</summary>
    [HttpPost("conversations/{conversationUuid:guid}/read")]
    public async Task<IActionResult> MarkRead(
        Guid conversationUuid,
        [FromQuery] Guid? otherUserUuid,
        CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var myUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var found = await conversations.MarkReadAsync(myUuid, conversationUuid, otherUserUuid, ct);
        if (!found)
            return NotFound(new { error = "Разговор не найден." });

        return NoContent();
    }

    // ── GET /api/messaging/e2e/state ─────────────────────────────────────────

    /// <summary>Returns the current E2E FSM account state.</summary>
    [HttpGet("e2e/state")]
    public async Task<IActionResult> GetE2EState(CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var myUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var result = await keyBackup.GetStateAsync(myUuid, ct);
        return Ok(result.Value);
    }

    // ── GET /api/messaging/e2e/key-backup ────────────────────────────────────

    /// <summary>Returns the stored password-encrypted E2E key backup.</summary>
    [HttpGet("e2e/key-backup")]
    public async Task<IActionResult> GetKeyBackup(CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var myUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var result = await keyBackup.GetKeyBackupAsync(myUuid, ct);
        if (!result.IsSuccess)
            return result.Code == E2EBackupErrorCode.NotFound
                ? NotFound(new { error = result.Error })
                : StatusCode(500, new { error = result.Error });
        return Ok(result.Value);
    }

    // ── PUT/POST /api/messaging/e2e/key-backup ────────────────────────────────────

    /// <summary>
    /// Stores or replaces the user's password-encrypted E2E key backup.
    /// Rejected when account state = locked or freeze = true.
    /// Rate-limited to 5 writes per day per user.
    /// POST duplicate: Selectel CDN blocks PUT on social.* — clients use POST in production.
    /// </summary>
    [HttpPut("e2e/key-backup")]
    [HttpPost("e2e/key-backup")]
    [EnableRateLimiting(MessagingModuleComposition.RateLimitPolicyE2EKeyBackupWrite)]
    public async Task<IActionResult> PutKeyBackup(
        [FromBody] PutKeyBackupRequest request,
        CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var myUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var result = await keyBackup.PutKeyBackupAsync(myUuid, request, ct);
        if (!result.IsSuccess)
        {
            return result.Code switch
            {
                E2EBackupErrorCode.AccountLocked => StatusCode(403, new { error = result.Error, code = "messaging.e2e.key_backup.account_locked" }),
                E2EBackupErrorCode.AccountFrozen => StatusCode(403, new { error = result.Error, code = "messaging.e2e.key_backup.account_frozen" }),
                E2EBackupErrorCode.Forbidden => Forbid(),
                E2EBackupErrorCode.Conflict => Conflict(new { error = result.Error }),
                _ => StatusCode(500, new { error = result.Error }),
            };
        }
        return NoContent();
    }

    // ── GET /api/messaging/e2e/recovery-backups ───────────────────────────────

    /// <summary>Returns metadata for all recovery backups (without ciphertext).</summary>
    [HttpGet("e2e/recovery-backups")]
    public async Task<IActionResult> GetRecoveryBackups(CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var myUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var result = await keyBackup.GetRecoveryBackupsAsync(myUuid, ct);
        return Ok(result.Value);
    }

    // ── GET /api/messaging/e2e/recovery-backup/{recoveryKeyId} ───────────────

    /// <summary>
    /// Returns the full recovery backup including ciphertext.
    /// Rate-limited to 5 per day per user (security event on each access).
    /// </summary>
    [HttpGet("e2e/recovery-backup/{recoveryKeyId:guid}")]
    [EnableRateLimiting(MessagingModuleComposition.RateLimitPolicyE2ERecovery)]
    public async Task<IActionResult> GetRecoveryBackup(
        Guid recoveryKeyId,
        CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var myUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var result = await keyBackup.GetRecoveryBackupAsync(myUuid, recoveryKeyId, ct);
        if (!result.IsSuccess)
            return NotFound(new { error = result.Error });
        return Ok(result.Value);
    }

    // ── PUT /api/messaging/e2e/recovery-backup ────────────────────────────────

    /// <summary>Stores or replaces a recovery backup (full payload with ciphertext).</summary>
    [HttpPut("e2e/recovery-backup")]
    public async Task<IActionResult> PutRecoveryBackup(
        [FromBody] RecoveryBackupPayload payload,
        CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var myUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        var result = await keyBackup.PutRecoveryBackupAsync(myUuid, payload, ct);
        if (!result.IsSuccess)
            return result.Code == E2EBackupErrorCode.Forbidden
                ? Forbid()
                : StatusCode(500, new { error = result.Error });
        return NoContent();
    }

    // ── POST /api/messaging/e2e/lock ─────────────────────────────────────────

    /// <summary>Transitions account state to Locked (idempotent, internal Auth event).</summary>
    [HttpPost("e2e/lock")]
    public async Task<IActionResult> LockE2E(CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var myUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });
        await keyBackup.LockAsync(myUuid, ct);
        return NoContent();
    }

    // ── POST /api/messaging/e2e/epochs ───────────────────────────────────────

    /// <summary>
    /// Creates a new key epoch after explicit UX confirmation.
    /// Allowed only when account state = locked (user chose not to recover old history).
    /// Transitions to active_new_epoch on success.
    /// </summary>
    [HttpPost("e2e/epochs")]
    public async Task<IActionResult> CreateEpoch(
        [FromBody] CreateEpochRequest request,
        CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var myUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var result = await epochs.CreateEpochAsync(myUuid, request, ct);
        if (!result.IsSuccess)
        {
            return result.Code switch
            {
                E2EEpochErrorCode.AccountNotInRequiredState =>
                    Conflict(new { code = "messaging.e2e.epochs.not_allowed_in_current_account_state", error = result.Error }),
                E2EEpochErrorCode.IdempotencyConflict =>
                    Conflict(new { code = "messaging.e2e.epochs.idempotency_conflict", error = result.Error }),
                E2EEpochErrorCode.Conflict =>
                    Conflict(new { error = result.Error }),
                _ => StatusCode(500, new { error = result.Error }),
            };
        }
        return NoContent();
    }

    // ── POST /api/messaging/e2e/unlock-complete/challenge ────────────────────

    /// <summary>
    /// Issues a short-lived challenge for the unlock-complete signing step.
    /// Rate-limited. Allowed only when account state = recovering.
    /// </summary>
    [HttpPost("e2e/unlock-complete/challenge")]
    [EnableRateLimiting(MessagingModuleComposition.RateLimitPolicyE2EChallenge)]
    public async Task<IActionResult> RequestUnlockChallenge(CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var myUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var result = await epochs.RequestUnlockChallengeAsync(myUuid, ct);
        if (!result.IsSuccess)
        {
            return result.Code == E2EEpochErrorCode.AccountNotInRequiredState
                ? StatusCode(403, new { error = result.Error })
                : StatusCode(500, new { error = result.Error });
        }
        return Ok(result.Value);
    }

    // ── POST /api/messaging/e2e/unlock-complete ───────────────────────────────

    /// <summary>
    /// Finalises an E2E unlock/recovery flow.
    /// Verifies Ed25519 signatures for each recovered epoch,
    /// replaces the password backup atomically, and transitions to active.
    /// </summary>
    [HttpPost("e2e/unlock-complete")]
    public async Task<IActionResult> UnlockComplete(
        [FromBody] UnlockCompleteRequest request,
        CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var myUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var result = await epochs.UnlockCompleteAsync(myUuid, request, ct);
        if (!result.IsSuccess)
        {
            return result.Code switch
            {
                E2EEpochErrorCode.RecoveredEpochsEmpty =>
                    BadRequest(new { code = "messaging.e2e.unlock_complete.recovered_epochs_empty", error = result.Error }),
                E2EEpochErrorCode.SignatureInvalid =>
                    BadRequest(new { code = "messaging.e2e.unlock_complete.signature_invalid", error = result.Error }),
                E2EEpochErrorCode.ChallengeExpiredOrUsed =>
                    BadRequest(new { code = "messaging.e2e.unlock_complete.challenge_expired_or_used", error = result.Error }),
                E2EEpochErrorCode.IdempotencyConflict =>
                    Conflict(new { code = "messaging.e2e.unlock_complete.idempotency_conflict", error = result.Error }),
                E2EEpochErrorCode.AccountNotInRequiredState =>
                    StatusCode(403, new { error = result.Error }),
                E2EEpochErrorCode.EpochSetHashUnchanged =>
                    Conflict(new { code = "messaging.e2e.unlock_complete.epoch_set_hash_unchanged", error = result.Error }),
                E2EEpochErrorCode.Conflict =>
                    Conflict(new { error = result.Error }),
                _ => StatusCode(500, new { error = result.Error }),
            };
        }
        return NoContent();
    }

    // ── POST /api/messaging/e2e/epochs/{keyEpochId}/devices/pending ──────────

    /// <summary>
    /// Registers a new device public key pair for the epoch as Pending.
    /// The trusted device (or old device in DtD flow) approves it separately.
    /// </summary>
    [HttpPost("e2e/epochs/{keyEpochId:guid}/devices/pending")]
    public async Task<IActionResult> AddPendingDevice(
        Guid keyEpochId,
        [FromBody] AddPendingDeviceRequest request,
        CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var myUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var result = await epochs.AddPendingDeviceAsync(myUuid, keyEpochId, request, ct);
        if (!result.IsSuccess)
        {
            return result.Code switch
            {
                E2EEpochErrorCode.AccountNotInRequiredState =>
                    StatusCode(403, new { error = result.Error }),
                E2EEpochErrorCode.NotFound =>
                    NotFound(new { error = result.Error }),
                _ => StatusCode(500, new { error = result.Error }),
            };
        }
        return Ok(result.Value);
    }

    // ── GET /api/messaging/e2e/epochs/{keyEpochId}/devices ───────────────────

    /// <summary>Returns all device key entries for the given epoch.</summary>
    [HttpGet("e2e/epochs/{keyEpochId:guid}/devices")]
    public async Task<IActionResult> GetDevices(
        Guid keyEpochId,
        CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var myUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var result = await epochs.GetDevicesAsync(myUuid, keyEpochId, ct);
        return Ok(result.Value ?? []);
    }

    // ── DELETE /api/messaging/e2e/epochs/{keyEpochId}/devices/{deviceUuid} ───

    /// <summary>Revokes a device key. Idempotent if already revoked.</summary>
    [HttpDelete("e2e/epochs/{keyEpochId:guid}/devices/{deviceUuid:guid}")]
    public async Task<IActionResult> RevokeDevice(
        Guid keyEpochId,
        Guid deviceUuid,
        CancellationToken ct = default)
    {
        if (!TryGetCurrentUser(out var myUuid))
            return Unauthorized(new { error = "Не удалось определить пользователя." });

        var result = await epochs.RevokeDeviceAsync(myUuid, keyEpochId, deviceUuid, ct);
        if (!result.IsSuccess)
        {
            return result.Code == E2EEpochErrorCode.NotFound
                ? NotFound(new { error = result.Error })
                : StatusCode(500, new { error = result.Error });
        }
        return NoContent();
    }
}
