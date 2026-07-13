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

    // Генерация статических фикстур живёт в ContractFixtureValidationTests.Generator_writes_fixtures_when_env_set
    // (раньше здесь был дубль, писавший в неверный каталог tests/artifacts).
}
