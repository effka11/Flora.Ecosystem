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

        // ── Music/E2E: поверхности MVC-контроллеров (расширение Фазы 0, next-architecture.md §6) ──
        // ВАЖНО: у MVC-контроллеров продукта DefaultIgnoreCondition = WhenWritingNull
        // (Class1.cs AddJsonOptions), поэтому null-поля в этих фикстурах ОТСУТСТВУЮТ,
        // а enum'ы сериализуются числами (JsonStringEnumConverter не подключён).
        // Minimal-API-эндпоинты (feed и пр.) пишут null явно — см. feed-page.json выше.

        Write(outputDir, "music-library.json", new
        {
            tracks = new object[]
            {
                new
                {
                    trackUuid = "55555555-5555-5555-5555-555555555555",
                    scope = 0, // MusicTrackScopeDto.Personal
                    title = "First Light",
                    artistDisplay = "Flora Artist",
                    tags = "lofi,chill",
                    genreId = "lofi",
                    licenseId = "cc-by",
                    coverColorId = "sunset",
                    trackKindId = "track",
                    hasCoverImage = true,
                    durationMs = 183000,
                    createdAt = "2026-06-12T10:00:00.000Z",
                    publishedAt = "2026-06-12T11:00:00.000Z",
                    artistCredits = new object[]
                    {
                        new
                        {
                            artistUuid = "66666666-6666-6666-6666-666666666666",
                            displayName = "Flora Artist",
                            joinerBefore = 0, // TrackArtistJoinerDto.None
                        },
                    },
                },
                new
                {
                    // Минимальный трек: nullable-поля (tags/genreId/licenseId/coverColorId/
                    // trackKindId/publishedAt) опущены — так их отдаёт WhenWritingNull.
                    trackUuid = "77777777-7777-7777-7777-777777777777",
                    scope = 1, // MusicTrackScopeDto.Platform
                    title = "Untitled",
                    artistDisplay = "Unknown",
                    hasCoverImage = false,
                    durationMs = 90000,
                    createdAt = "2026-06-12T09:00:00.000Z",
                    artistCredits = Array.Empty<object>(),
                },
            },
        });
        Write(outputDir, "music-playlists.json", new
        {
            playlists = new object[]
            {
                new
                {
                    id = "system:favorites",
                    title = "Favorites",
                    trackCount = 12,
                    kind = 0, // MusicPlaylistKindDto.System
                    variant = "favorites",
                    canDelete = false,
                    coverColorId = "sunset",
                },
                new
                {
                    // coverColorId = null опущен (WhenWritingNull).
                    id = "88888888-8888-8888-8888-888888888888",
                    title = "My Mix",
                    trackCount = 3,
                    kind = 1, // MusicPlaylistKindDto.User
                    variant = "user",
                    canDelete = true,
                },
            },
        });

        Write(outputDir, "e2e-state.json", new
        {
            state = "active",
            freeze = false,
            updatedAt = "2026-06-12T10:00:00.000Z",
        });
        Write(outputDir, "e2e-key-backup.json", new
        {
            version = 1,
            backupRevision = 2,
            backupKeyId = "99999999-9999-9999-9999-999999999999",
            userUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            primaryKeyEpochId = "00000000-0000-4000-8000-000000000001",
            epochSetRevision = 1,
            epochSetHashBase64Url = "5qXpkc9M2xJHhYQpqSMLPg",
            kdf = new
            {
                name = "argon2id",
                memoryKiB = 65536,
                iterations = 4,
                parallelism = 2,
                saltBase64Url = "c2FsdC1zYWx0LXNhbHQtMTY",
            },
            aead = new
            {
                name = "xchacha20poly1305",
                nonceBase64Url = "bm9uY2UtMjQtYnl0ZXMtbm9uY2UtMjQ",
            },
            ciphertextBase64Url = "Y2lwaGVydGV4dC1zYW1wbGU",
        });
        // GET /api/messaging/e2e/recovery-backups — массив в корне ответа;
        // usedAt = null опущен (WhenWritingNull).
        Write(outputDir, "e2e-recovery-backups.json", new object[]
        {
            new
            {
                recoveryKeyId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
                recoveryRevision = 1,
                primaryKeyEpochId = "00000000-0000-4000-8000-000000000001",
                epochSetRevision = 1,
                epochSetHashBase64Url = "5qXpkc9M2xJHhYQpqSMLPg",
                wordlist = new { id = "bip39-en", wordsCount = 12 },
                createdAt = "2026-06-12T10:00:00.000Z",
                updatedAt = "2026-06-12T10:00:00.000Z",
            },
        });
    }

    private static void Write(string dir, string name, object payload)
    {
        var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(Path.Combine(dir, name), json);
    }
}
