using FirebaseAdmin;
using FirebaseAdmin.Messaging;
using Flora.Notifications.Application;
using Google.Apis.Auth.OAuth2;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace Flora.Notifications.Infrastructure;

public sealed class FcmPushSender : IMessagePushDispatcher
{
    private readonly ILogger<FcmPushSender> _log;
    private readonly IPushTokenService _pushTokens;
    private readonly bool _enabled;

    public FcmPushSender(IConfiguration configuration, IPushTokenService pushTokens, ILogger<FcmPushSender> log)
    {
        _log = log;
        _pushTokens = pushTokens;
        _enabled = TryInitializeFirebase(configuration, log);
        if (_enabled)
            log.LogInformation("FCM push enabled for message notifications.");
        else
            log.LogInformation(
                "FCM push disabled. Set Push:Firebase:CredentialsJson or CredentialsPath (see Flora.API/appsettings.Local.example.json).");
    }

    public Task SendMessagePushAsync(
        Guid recipientUserUuid,
        IReadOnlyList<string> deviceTokens,
        string senderDisplayName,
        string body,
        Guid conversationUuid,
        Guid senderUserUuid,
        CancellationToken ct = default)
    {
        var title = string.IsNullOrWhiteSpace(senderDisplayName) ? "Flora" : senderDisplayName.Trim();
        var notificationBody = string.IsNullOrWhiteSpace(body) ? "Новое сообщение" : body.Trim();
        if (notificationBody.Length > 120) notificationBody = notificationBody[..117] + "...";

        var data = new Dictionary<string, string>
        {
            ["type"] = "message",
            ["conversationUuid"] = conversationUuid.ToString(),
            ["senderUserUuid"] = senderUserUuid.ToString(),
            ["messagePreview"] = notificationBody,
            ["tag"] = conversationUuid.ToString(),
        };

        return SendAsync(
            recipientUserUuid,
            deviceTokens,
            title,
            notificationBody,
            data,
            androidChannelId: "messages",
            highPriority: true,
            androidTitle: title,
            androidBody: notificationBody,
            ct: ct);
    }

    public Task SendInboxNotificationPushAsync(
        Guid recipientUserUuid,
        IReadOnlyList<string> deviceTokens,
        Guid notificationUuid,
        string inboxType,
        string category,
        string text,
        string? actorDisplayName,
        Guid? postUuid,
        Guid? commentUuid,
        CancellationToken ct = default)
    {
        var title = string.IsNullOrWhiteSpace(actorDisplayName) ? "Flora" : actorDisplayName.Trim();
        var body = text.Trim();
        if (body.Length > 120) body = body[..117] + "...";

        var data = new Dictionary<string, string>
        {
            ["type"] = "notification",
            ["notificationUuid"] = notificationUuid.ToString(),
            ["inboxType"] = inboxType,
            ["category"] = category,
        };
        if (postUuid is Guid post) data["postUuid"] = post.ToString();
        if (commentUuid is Guid comment) data["commentUuid"] = comment.ToString();

        return SendAsync(
            recipientUserUuid,
            deviceTokens,
            title,
            body,
            data,
            androidChannelId: "notifications",
            highPriority: false,
            ct: ct);
    }

    private async Task SendAsync(
        Guid recipientUserUuid,
        IReadOnlyList<string> deviceTokens,
        string title,
        string body,
        IReadOnlyDictionary<string, string> data,
        string androidChannelId,
        bool highPriority,
        string? androidTitle = null,
        string? androidBody = null,
        CancellationToken ct = default)
    {
        if (!_enabled || deviceTokens.Count == 0) return;

        foreach (var token in deviceTokens.Distinct())
        {
            if (string.IsNullOrWhiteSpace(token)) continue;

            try
            {
                var message = new Message
                {
                    Token = token,
                    Notification = new Notification { Title = title, Body = body },
                    Data = new Dictionary<string, string>(data),
                    Android = new AndroidConfig
                    {
                        Priority = highPriority ? Priority.High : Priority.Normal,
                        Notification = new AndroidNotification
                        {
                            ChannelId = androidChannelId,
                            Title = androidTitle ?? title,
                            Body = androidBody ?? body,
                            Tag = data.TryGetValue("tag", out var tag) ? tag : null,
                        },
                    },
                };

                await FirebaseMessaging.DefaultInstance.SendAsync(message, ct);
            }
            catch (FirebaseMessagingException ex) when (IsInvalidToken(ex))
            {
                _log.LogInformation(
                    "Removing invalid FCM token prefix {Prefix}",
                    token.Length > 8 ? token[..8] : token);
                await _pushTokens.UnregisterAsync(recipientUserUuid, token, ct);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "FCM send failed for token prefix {Prefix}", token.Length > 8 ? token[..8] : token);
            }
        }
    }

    private static bool TryInitializeFirebase(IConfiguration configuration, ILogger log)
    {
        var section = configuration.GetSection("Push:Firebase");
        var json = section["CredentialsJson"]?.Trim();
        var path = section["CredentialsPath"]?.Trim();

        if (string.IsNullOrEmpty(json) && string.IsNullOrEmpty(path))
            return false;

        try
        {
            if (FirebaseApp.DefaultInstance is null)
            {
                GoogleCredential credential = !string.IsNullOrEmpty(json)
                    ? GoogleCredential.FromJson(json)
                    : GoogleCredential.FromFile(ResolveCredentialFilePath(path!, log)!);

                FirebaseApp.Create(new AppOptions { Credential = credential });
            }

            return true;
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "FCM disabled: failed to initialize Firebase Admin SDK");
            return false;
        }
    }

    private static string ResolveApiContentRoot()
    {
        foreach (var start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
        {
            var dir = new DirectoryInfo(Path.GetFullPath(start));
            while (dir is not null)
            {
                if (File.Exists(Path.Combine(dir.FullName, "Flora.API.csproj")))
                    return dir.FullName;

                var nestedApi = Path.Combine(dir.FullName, "Flora.API");
                if (File.Exists(Path.Combine(nestedApi, "Flora.API.csproj")))
                    return nestedApi;

                dir = dir.Parent;
            }
        }

        return Directory.GetCurrentDirectory();
    }

    private static string? ResolveCredentialFilePath(string configuredPath, ILogger log)
    {
        var contentRoot = ResolveApiContentRoot();
        var candidates = new List<string>();
        if (Path.IsPathRooted(configuredPath))
            candidates.Add(configuredPath);
        else
        {
            candidates.Add(Path.Combine(contentRoot, configuredPath));
            candidates.Add(Path.GetFullPath(configuredPath));
        }

        foreach (var candidate in candidates)
        {
            if (File.Exists(candidate))
                return candidate;
        }

        var secretsDir = Path.Combine(contentRoot, "secrets");
        if (Directory.Exists(secretsDir))
        {
            var jsonFiles = Directory
                .GetFiles(secretsDir, "*.json")
                .Where(f => !f.EndsWith(".example.json", StringComparison.OrdinalIgnoreCase))
                .ToArray();
            if (jsonFiles.Length == 1)
            {
                log.LogInformation(
                    "Push:Firebase:CredentialsPath not found; using {CredentialFile}",
                    Path.GetFileName(jsonFiles[0]));
                return jsonFiles[0];
            }
        }

        return candidates[0];
    }

    private static bool IsInvalidToken(FirebaseMessagingException ex) =>
        ex.MessagingErrorCode is MessagingErrorCode.Unregistered
            or MessagingErrorCode.InvalidArgument
            or MessagingErrorCode.SenderIdMismatch;
}
