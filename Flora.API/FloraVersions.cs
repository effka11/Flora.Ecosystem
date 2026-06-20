using System.Reflection;
using System.Text.Json;

namespace Flora.API;

public sealed record FloraVersionResponse
{
    public required string Ecosystem { get; init; }
    public required IReadOnlyDictionary<string, string> Products { get; init; }
    public required string Api { get; init; }
    public string? Commit { get; init; }
}

public static class FloraVersions
{
    private static readonly Lazy<FloraVersionResponse> Cached = new(Build);

    public static FloraVersionResponse Current => Cached.Value;

    private static FloraVersionResponse Build()
    {
        var ecosystem = "unknown";
        var products = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        var path = Path.Combine(AppContext.BaseDirectory, "flora-versions.json");
        if (File.Exists(path))
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            var root = doc.RootElement;
            if (root.TryGetProperty("ecosystem", out var ecoProp))
                ecosystem = ecoProp.GetString() ?? ecosystem;
            if (root.TryGetProperty("products", out var productsProp) &&
                productsProp.ValueKind == JsonValueKind.Object)
            {
                foreach (var prop in productsProp.EnumerateObject())
                {
                    var value = prop.Value.GetString();
                    if (!string.IsNullOrWhiteSpace(value))
                        products[prop.Name] = value;
                }
            }
        }

        var assembly = Assembly.GetExecutingAssembly();
        var apiVersion =
            assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? assembly.GetName().Version?.ToString(3)
            ?? "unknown";

        var commit = Environment.GetEnvironmentVariable("FLORA_BUILD_COMMIT")?.Trim();
        if (string.IsNullOrEmpty(commit))
            commit = null;

        return new FloraVersionResponse
        {
            Ecosystem = ecosystem,
            Products = products,
            Api = apiVersion,
            Commit = commit,
        };
    }
}
