using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace Flora.ContractFixtures;

/// <summary>
/// Фиксирует фактические ответы хост-эндпоинтов `/`, `/health`, `/version` —
/// эталон паритета для нативных маршрутов Rust-шлюза (next-architecture.md, Фаза 0).
/// Захват live-ответов вместо ручных форм: контракт снимается с работающего приложения.
/// </summary>
public sealed class HostEndpointFixtureTests : IClassFixture<WebApplicationFactory<Program>>
{
    private static readonly (string Path, string FixtureName)[] HostEndpoints =
    [
        ("/", "api-root.json"),
        ("/health", "api-health.json"),
        ("/version", "api-version.json"),
    ];

    private readonly WebApplicationFactory<Program> _factory;

    public HostEndpointFixtureTests(WebApplicationFactory<Program> factory) => _factory = factory;

    [Fact]
    public async Task Host_endpoints_return_ok_json()
    {
        var client = _factory.CreateClient();
        foreach (var (path, _) in HostEndpoints)
        {
            var response = await client.GetAsync(path);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.StartsWith("application/json", response.Content.Headers.ContentType?.MediaType);
        }
    }

    [Fact]
    public async Task Generator_can_refresh_host_endpoint_fixtures()
    {
        if (!string.Equals(Environment.GetEnvironmentVariable("UPDATE_CONTRACT_FIXTURES"), "1", StringComparison.Ordinal))
            return;

        var dir = Path.GetFullPath(Path.Combine(
            AppContext.BaseDirectory, "..", "..", "..", "..", "..", "artifacts", "contract-fixtures"));
        Directory.CreateDirectory(dir);

        var client = _factory.CreateClient();
        foreach (var (path, fixtureName) in HostEndpoints)
        {
            var raw = await client.GetStringAsync(path);
            using var doc = JsonDocument.Parse(raw);
            var pretty = JsonSerializer.Serialize(doc.RootElement, new JsonSerializerOptions { WriteIndented = true });
            await File.WriteAllTextAsync(Path.Combine(dir, fixtureName), pretty);
        }
    }
}
