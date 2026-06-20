using System.Text.Json;

namespace Flora.ContractFixtures;

public static class ContractFixtureGenerator
{
    public static void WriteAll(string outputDir)
    {
        Directory.CreateDirectory(outputDir);
        Write(outputDir, "auth-login.json", new
        {
            accessToken = "eyJ.sample.access",
            refreshToken = "refresh-token-sample",
            expiresAt = "2026-06-12T12:00:00.000Z",
            requiresProfileCompletion = false,
        });
        Write(outputDir, "auth-refresh.json", new
        {
            accessToken = "eyJ.sample.access.rotated",
            refreshToken = "refresh-token-rotated",
            expiresAt = "2026-06-12T13:00:00.000Z",
            requiresProfileCompletion = false,
        });
        Write(outputDir, "auth-me.json", new
        {
            userUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            username = "flora_user",
            displayName = "Flora User",
            followersCount = 10,
            followingCount = 5,
        });
        Write(outputDir, "feed-page.json", new
        {
            items = new[]
            {
                new
                {
                    postUuid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                    authorUserUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    authorUsername = "flora_user",
                    authorDisplayName = "Flora User",
                    text = "Hello Flora",
                    createdAt = "2026-06-12T10:00:00.000Z",
                    likeCount = 0,
                    commentCount = 0,
                    repostCount = 0,
                    viewCount = 0,
                    likedByMe = false,
                    repostedByMe = false,
                    imageUuids = Array.Empty<string>(),
                    videoUuid = (string?)null,
                    videoStatus = (string?)null,
                },
            },
            nextCursor = (string?)null,
        });
        Write(outputDir, "messaging-conversations.json", new
        {
            items = new[]
            {
                new
                {
                    conversationUuid = "11111111-1111-1111-1111-111111111111",
                    otherUserUuid = "22222222-2222-2222-2222-222222222222",
                    otherUsername = "friend",
                    otherDisplayName = "Friend",
                    lastMessageContent = "Hello",
                    lastMessageAt = "2026-06-12T10:00:00.000Z",
                    lastMessageIsFromMe = false,
                    unreadCount = 1,
                    otherUserIsOnline = false,
                },
            },
            nextCursor = (string?)null,
        });
        Write(outputDir, "messaging-messages.json", new
        {
            items = new[]
            {
                new
                {
                    messageUuid = "33333333-3333-3333-3333-333333333333",
                    conversationUuid = "11111111-1111-1111-1111-111111111111",
                    senderUserUuid = "22222222-2222-2222-2222-222222222222",
                    encryptedPayload = "SGVsbG8=",
                    createdAt = "2026-06-12T10:00:00.000Z",
                    isFromMe = false,
                },
            },
            nextCursor = (string?)null,
        });
        Write(outputDir, "notifications-page.json", new
        {
            items = new[]
            {
                new
                {
                    notificationUuid = "44444444-4444-4444-4444-444444444444",
                    type = "follow",
                    category = "social",
                    text = "Новый подписчик @friend",
                    createdAt = "2026-06-12T09:00:00.000Z",
                    isRead = false,
                },
            },
        });
        Write(outputDir, "messaging-unread-count.json", new { unreadCount = 3 });
    }

    private static void Write(string dir, string name, object payload)
    {
        var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(Path.Combine(dir, name), json);
    }
}
