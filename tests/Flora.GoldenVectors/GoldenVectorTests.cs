using System.Security.Claims;
using System.Text.Json;
using Flora.Auth.Infrastructure.Options;
using Flora.Auth.Infrastructure.Services;
using Flora.Shared;
using Microsoft.Extensions.Options;
using Xunit;

namespace Flora.GoldenVectors;

public sealed class GoldenVectorTests
{
    private static string VectorsDir =>
        Path.GetFullPath(Path.Combine(
            AppContext.BaseDirectory, "..", "..", "..", "..", "..",
            "docs", "test-vectors", "backend-parity"));

    private static string FiraVectorsDir =>
        Path.GetFullPath(Path.Combine(
            AppContext.BaseDirectory, "..", "..", "..", "..", "..",
            "docs", "test-vectors", "fira"));

    [Fact]
    public void Generator_writes_vectors_when_env_set()
    {
        if (!string.Equals(Environment.GetEnvironmentVariable("UPDATE_GOLDEN_VECTORS"), "1", StringComparison.Ordinal))
            return;

        GoldenVectorGenerator.WriteAll(VectorsDir);
        Assert.True(File.Exists(Path.Combine(VectorsDir, "uuid-v1.json")));
        Assert.True(File.Exists(Path.Combine(VectorsDir, "jwt-hs256-v1.json")));
        Assert.True(File.Exists(Path.Combine(VectorsDir, "argon2id-v1.json")));
    }

    [Fact]
    public void Fira_generator_writes_vectors_when_env_set()
    {
        if (!string.Equals(Environment.GetEnvironmentVariable("UPDATE_GOLDEN_VECTORS"), "1", StringComparison.Ordinal))
            return;

        FiraGoldenVectorGenerator.WriteAll(FiraVectorsDir);
        Assert.True(File.Exists(Path.Combine(FiraVectorsDir, "fira-f-scorer-v1.json")));
        Assert.True(File.Exists(Path.Combine(FiraVectorsDir, "fira-f-postprocessing-v1.json")));
        Assert.True(File.Exists(Path.Combine(FiraVectorsDir, "fira-c-scorer-v1.json")));
        Assert.True(File.Exists(Path.Combine(FiraVectorsDir, "fira-p-scorer-v1.json")));
        Assert.True(File.Exists(Path.Combine(FiraVectorsDir, "fira-m-scorer-v1.json")));
    }

    /// <summary>
    /// Freeze-контроль формул FIRA (§15 FIRA.md): регенерация в temp-каталог обязана быть
    /// байт-в-байт идентичной закоммиченным векторам. Расхождение = формула изменилась —
    /// остановись и сверься с freeze-правилами (next-architecture.md §4, skill /rust-migration).
    /// </summary>
    [Fact]
    public void Fira_vectors_match_reference_implementation()
    {
        Assert.True(Directory.Exists(FiraVectorsDir),
            $"Missing FIRA vectors dir: {FiraVectorsDir} (run Scripts/generate-golden-vectors.ps1)");

        var tempDir = Path.Combine(Path.GetTempPath(), "flora-fira-vectors-" + Guid.NewGuid().ToString("N"));
        try
        {
            FiraGoldenVectorGenerator.WriteAll(tempDir);
            foreach (var freshPath in Directory.GetFiles(tempDir, "*.json"))
            {
                var name = Path.GetFileName(freshPath);
                var committedPath = Path.Combine(FiraVectorsDir, name);
                Assert.True(File.Exists(committedPath), $"Missing committed FIRA vector: {committedPath}");
                Assert.Equal(File.ReadAllText(committedPath), File.ReadAllText(freshPath));
            }
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    [Fact]
    public void Uuid_vector_matches_reference_implementation()
    {
        using var doc = LoadVector("uuid-v1.json");
        var root = doc.RootElement;

        Assert.Equal(
            UuidV5.FloraNamespaceDnsScope.ToString("d"),
            root.GetProperty("namespaceDns").GetString());

        foreach (var c in root.GetProperty("dmConversationUuid").EnumerateArray())
        {
            var a = Guid.Parse(c.GetProperty("userA").GetString()!);
            var b = Guid.Parse(c.GetProperty("userB").GetString()!);
            Assert.Equal(c.GetProperty("expected").GetString(), UuidV5.DmConversationUuid(a, b).ToString("d"));
        }

        foreach (var c in root.GetProperty("agreementPublicKeyId").EnumerateArray())
        {
            var user = Guid.Parse(c.GetProperty("userUuid").GetString()!);
            var epoch = Guid.Parse(c.GetProperty("keyEpochId").GetString()!);
            Assert.Equal(c.GetProperty("expected").GetString(), UuidV5.AgreementPublicKeyId(user, epoch).ToString("d"));
        }
    }

    [Fact]
    public void Jwt_vector_token_is_valid_for_reference_validator()
    {
        using var doc = LoadVector("jwt-hs256-v1.json");
        var root = doc.RootElement;
        var token = root.GetProperty("token").GetString()!;

        var principal = CreateReferenceTokenService(root.GetProperty("secretUtf8").GetString()!)
            .ValidateAccessToken(token);

        Assert.NotNull(principal);
        Assert.Equal(GoldenVectorGenerator.JwtSubject, principal!.FindFirstValue(ClaimTypes.NameIdentifier));
    }

    /// <summary>
    /// Кросс-языковой тест (next-architecture.md §4.1): токен, выпущенный Rust-реализацией
    /// (Backend, регенерация: cargo run -p flora-parity --bin gen-cross-vectors),
    /// обязан проходить валидацию боевым C#-кодом JwtTokenService.
    /// </summary>
    [Fact]
    public void Rust_issued_token_is_valid_in_csharp()
    {
        var path = Path.Combine(VectorsDir, "jwt-hs256-rust-v1.json");
        Assert.True(File.Exists(path), $"Missing cross-language vector: {path} (generate from Backend/)");

        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var root = doc.RootElement;
        var token = root.GetProperty("token").GetString()!;

        var principal = CreateReferenceTokenService(root.GetProperty("secretUtf8").GetString()!)
            .ValidateAccessToken(token);

        Assert.NotNull(principal);
        Assert.Equal(
            root.GetProperty("expectedSub").GetString(),
            principal!.FindFirstValue(ClaimTypes.NameIdentifier));
        Assert.Equal(
            root.GetProperty("expectedEmail").GetString(),
            principal.FindFirstValue(ClaimTypes.Email));
    }

    [Fact]
    public void Argon2_vector_verifies_with_reference_hasher()
    {
        using var doc = LoadVector("argon2id-v1.json");
        var hasher = new Argon2PasswordHasher();

        foreach (var c in doc.RootElement.GetProperty("cases").EnumerateArray())
        {
            var password = c.GetProperty("password").GetString()!;
            var storedHash = c.GetProperty("storedHash").GetString()!;
            Assert.True(hasher.Verify(password, storedHash), $"Reference hasher rejected vector for '{password}'");
            Assert.False(hasher.Verify(password + "-wrong", storedHash));
        }
    }

    private static JwtTokenService CreateReferenceTokenService(string secret) =>
        new(Options.Create(new JwtOptions
        {
            Issuer = GoldenVectorGenerator.JwtIssuer,
            Audience = GoldenVectorGenerator.JwtAudience,
            Secret = secret,
            AccessTokenMinutes = 15,
            RefreshTokenDays = 7,
        }));

    private static JsonDocument LoadVector(string name)
    {
        var path = Path.Combine(VectorsDir, name);
        Assert.True(File.Exists(path), $"Missing golden vector: {path} (run Scripts/generate-golden-vectors.ps1)");
        return JsonDocument.Parse(File.ReadAllText(path));
    }
}
