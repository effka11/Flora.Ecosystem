using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace Flora.ContractFixtures;

public sealed class ApiHealthFixtureTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client;

    public ApiHealthFixtureTests(WebApplicationFactory<Program> factory)
    {
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task Health_returns_ok_json()
    {
        var response = await _client.GetAsync("/health");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("healthy", body, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Generator_can_refresh_static_fixtures()
    {
        if (!string.Equals(Environment.GetEnvironmentVariable("UPDATE_CONTRACT_FIXTURES"), "1", StringComparison.Ordinal))
            return;

        var dir = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "artifacts", "contract-fixtures"));
        ContractFixtureGenerator.WriteAll(dir);
        Assert.True(Directory.Exists(dir));
    }
}
