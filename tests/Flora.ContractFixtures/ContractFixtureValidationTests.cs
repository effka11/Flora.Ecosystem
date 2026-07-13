using System.Text.Json;
using Xunit;

namespace Flora.ContractFixtures;

public sealed class ContractFixtureValidationTests
{
    private static string FixturesDir =>
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "artifacts", "contract-fixtures"));

    public static IEnumerable<object[]> RequiredFixtures =>
    [
        ["auth-login.json", new[] { "accessToken", "refreshToken", "expiresAt" }],
        ["auth-refresh.json", new[] { "accessToken", "refreshToken", "expiresAt" }],
        ["auth-me.json", new[] { "userUuid", "username", "displayName" }],
        ["feed-page.json", new[] { "items" }],
        ["messaging-conversations.json", new[] { "items" }],
        ["messaging-messages.json", new[] { "items" }],
        ["messaging-unread-count.json", new[] { "unreadCount" }],
        ["notifications-page.json", new[] { "items" }],
        ["music-library.json", new[] { "tracks" }],
        ["music-playlists.json", new[] { "playlists" }],
        ["e2e-state.json", new[] { "state", "freeze", "updatedAt" }],
        ["e2e-key-backup.json", new[] { "version", "backupKeyId", "kdf", "aead", "ciphertextBase64Url" }],
    ];

    [Theory]
    [MemberData(nameof(RequiredFixtures))]
    public void Fixture_exists_and_has_required_keys(string fileName, string[] requiredKeys)
    {
        var path = Path.Combine(FixturesDir, fileName);
        Assert.True(File.Exists(path), $"Missing fixture: {path}");
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        Assert.Equal(JsonValueKind.Object, doc.RootElement.ValueKind);
        foreach (var key in requiredKeys)
        {
            Assert.True(doc.RootElement.TryGetProperty(key, out _), $"Fixture {fileName} missing key '{key}'");
        }
    }

    [Fact]
    public void Recovery_backups_fixture_is_array_without_ciphertext()
    {
        // GET /api/messaging/e2e/recovery-backups — массив RecoveryBackupMeta в корне;
        // ciphertext отдаёт только точечный GET recovery-backup/{id}.
        var path = Path.Combine(FixturesDir, "e2e-recovery-backups.json");
        Assert.True(File.Exists(path), $"Missing fixture: {path}");
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        Assert.Equal(JsonValueKind.Array, doc.RootElement.ValueKind);
        foreach (var entry in doc.RootElement.EnumerateArray())
        {
            Assert.True(entry.TryGetProperty("recoveryKeyId", out _));
            Assert.False(
                entry.TryGetProperty("ciphertextBase64Url", out _),
                "метаданные recovery-backups не должны содержать ciphertext");
        }
    }

    [Fact]
    public void Generator_writes_fixtures_when_env_set()
    {
        if (!string.Equals(Environment.GetEnvironmentVariable("UPDATE_CONTRACT_FIXTURES"), "1", StringComparison.Ordinal))
        {
            return;
        }

        Directory.CreateDirectory(FixturesDir);
        ContractFixtureGenerator.WriteAll(FixturesDir);
        Assert.True(Directory.GetFiles(FixturesDir, "*.json").Length >= 5);
    }
}
