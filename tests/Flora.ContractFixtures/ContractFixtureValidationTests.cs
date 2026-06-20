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
