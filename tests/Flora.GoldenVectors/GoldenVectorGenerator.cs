using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Flora.Shared;
using Konscious.Security.Cryptography;
using Microsoft.IdentityModel.Tokens;

namespace Flora.GoldenVectors;

/// <summary>
/// Генератор golden-векторов для паритета C# → Rust (next-architecture.md §7.1).
/// Детерминирован: повторный запуск перезаписывает файлы идентичным содержимым.
/// Выход: docs/test-vectors/backend-parity/*.json. Руками файлы не редактировать.
/// </summary>
public static class GoldenVectorGenerator
{
    /// <summary>Тестовый секрет (≥32 символов) — только для векторов, не боевой.</summary>
    public const string JwtTestSecret = "flora-backend-parity-jwt-secret-v1-0123456789";

    public const string JwtIssuer = "Flora.Auth";
    public const string JwtAudience = "Flora.Ecosystem";
    public const string JwtSubject = "7f2c9a4e-1b3d-4c5e-8f6a-2d1e0b9c8a7f";
    public const string JwtEmail = "parity@flora.local";
    public const string JwtId = "0123456789abcdef0123456789abcdef";

    /// <summary>Далёкое фиксированное будущее, чтобы вектор не протухал по lifetime-валидации.</summary>
    public static readonly DateTime JwtExpires = new(2126, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    public static void WriteAll(string outputDir)
    {
        Directory.CreateDirectory(outputDir);
        WriteJson(outputDir, "uuid-v1.json", BuildUuidVectors());
        WriteJson(outputDir, "jwt-hs256-v1.json", BuildJwtVector());
        WriteJson(outputDir, "argon2id-v1.json", BuildArgon2Vectors());
    }

    // --- UUID v5 / v7 (эталон: Flora.Shared/UuidV5.cs, FloraUuid.cs) ---

    private static object BuildUuidVectors()
    {
        var userA = Guid.Parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        var userB = Guid.Parse("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
        var epoch = Guid.Parse("00000000-0000-4000-8000-000000000001");
        var mixedCase = Guid.Parse("0198C5B6-7E2D-7ABC-9DEF-0123456789AB");

        return new
        {
            vectorId = "backend_parity_uuid_v1",
            namespaceDns = UuidV5.FloraNamespaceDnsScope.ToString("d"),
            v5FromNamespaceAndUtf8Name = new[]
            {
                V5Case("flora.example"),
                V5Case(""),
                V5Case("юникод-имя-🌸"),
                V5Case("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa|bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb|fscp-dm-v1"),
            },
            dmConversationUuid = new[]
            {
                DmCase(userA, userB),
                DmCase(userB, userA),
                DmCase(userA, userA),
                DmCase(mixedCase, userB),
            },
            agreementPublicKeyId = new[]
            {
                AgreementCase(userA, epoch),
                AgreementCase(mixedCase, epoch),
            },
            // Байты фиксированы (big-endian RFC-порядок) — проверяется одинаковая интерпретация
            // version/variant/timestamp и lowercase-форматирование на обоих языках.
            v7Samples = BuildV7Samples(),
        };

        static object V5Case(string name) => new
        {
            name,
            expected = UuidV5.FromNamespaceAndUtf8Name(UuidV5.FloraNamespaceDnsScope, name).ToString("d"),
        };

        static object DmCase(Guid a, Guid b) => new
        {
            userA = a.ToString("d"),
            userB = b.ToString("d"),
            expected = UuidV5.DmConversationUuid(a, b).ToString("d"),
        };

        static object AgreementCase(Guid user, Guid epoch) => new
        {
            userUuid = user.ToString("d"),
            keyEpochId = epoch.ToString("d"),
            expected = UuidV5.AgreementPublicKeyId(user, epoch).ToString("d"),
        };
    }

    private static object[] BuildV7Samples()
    {
        // Timestamp (unix ms, 48 бит) + фиксированные rand-биты с проставленными version/variant.
        var samples = new (long UnixMs, string RandHex)[]
        {
            (0L, "000000000000000000"),
            (1_750_000_000_000L, "0123456789abcdef01"),
            (4_922_553_600_000L, "fedcba9876543210fe"),
        };

        return samples.Select(s =>
        {
            var bytes = new byte[16];
            for (var i = 0; i < 6; i++)
                bytes[i] = (byte)(s.UnixMs >> (8 * (5 - i)));
            var rand = Convert.FromHexString(s.RandHex.PadRight(20, '0'));
            Array.Copy(rand, 0, bytes, 6, 10);
            bytes[6] = (byte)((bytes[6] & 0x0F) | 0x70);
            bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80);

            var guid = new Guid(bytes, bigEndian: true);
            if (guid.Version != 7)
                throw new InvalidOperationException("v7 sample must have version 7");

            return new
            {
                bytesHex = Convert.ToHexStringLower(bytes),
                expectedString = guid.ToString("d"),
                unixTimestampMs = s.UnixMs,
            };
        }).ToArray();
    }

    // --- JWT HS256 (эталон: JwtTokenService.cs — тот же набор клеймов и параметров) ---

    private static object BuildJwtVector()
    {
        // Воспроизводит CreateTokenPair из Flora.Auth.Infrastructure/Services/JwtTokenService.cs
        // с фиксированным expires (сервис берёт UtcNow — для стабильного вектора значение зафиксировано).
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(JwtTestSecret));
        var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

        var claims = new[]
        {
            new Claim(JwtRegisteredClaimNames.Sub, JwtSubject),
            new Claim(JwtRegisteredClaimNames.Email, JwtEmail),
            new Claim(JwtRegisteredClaimNames.Jti, JwtId),
            new Claim(ClaimTypes.NameIdentifier, JwtSubject),
            new Claim(ClaimTypes.Email, JwtEmail),
        };

        var token = new JwtSecurityToken(
            JwtIssuer,
            JwtAudience,
            claims,
            expires: JwtExpires,
            signingCredentials: creds);

        var encoded = new JwtSecurityTokenHandler().WriteToken(token);
        var parts = encoded.Split('.');

        return new
        {
            vectorId = "backend_parity_jwt_hs256_v1",
            algorithm = "HS256",
            secretUtf8 = JwtTestSecret,
            issuer = JwtIssuer,
            audience = JwtAudience,
            clockSkewSeconds = 60,
            token = encoded,
            // Фактические wire-байты header/payload — фиксируют .NET outbound claim mapping
            // (nameid, дубль email) до Фазы 2b, как требует next-architecture.md §10.
            header = DecodePart(parts[0]),
            payload = DecodePart(parts[1]),
        };
    }

    private static JsonElement DecodePart(string base64Url)
    {
        var padded = base64Url.Replace('-', '+').Replace('_', '/');
        padded = padded.PadRight(padded.Length + (4 - padded.Length % 4) % 4, '=');
        using var doc = JsonDocument.Parse(Convert.FromBase64String(padded));
        return doc.RootElement.Clone();
    }

    // --- Argon2id (эталон: Argon2PasswordHasher.cs — Base64(salt16‖hash32), t=4, m=65536, p=2) ---

    private static object BuildArgon2Vectors()
    {
        return new
        {
            vectorId = "backend_parity_argon2id_v1",
            format = "base64(salt16 || hash32)",
            iterations = 4,
            memoryKib = 65536,
            parallelism = 2,
            cases = new[]
            {
                Argon2Case(
                    "correct horse battery staple — флора",
                    "000102030405060708090a0b0c0d0e0f"),
                Argon2Case(
                    "простой-пароль-123",
                    "f0e1d2c3b4a5968778695a4b3c2d1e0f"),
            },
        };

        static object Argon2Case(string password, string saltHex)
        {
            var salt = Convert.FromHexString(saltHex);
            using var argon2 = new Argon2id(Encoding.UTF8.GetBytes(password))
            {
                Salt = salt,
                DegreeOfParallelism = 2,
                Iterations = 4,
                MemorySize = 65536,
            };
            var hash = argon2.GetBytes(32);
            var combined = new byte[salt.Length + hash.Length];
            Buffer.BlockCopy(salt, 0, combined, 0, salt.Length);
            Buffer.BlockCopy(hash, 0, combined, salt.Length, hash.Length);
            return new
            {
                password,
                storedHash = Convert.ToBase64String(combined),
            };
        }
    }

    private static void WriteJson(string dir, string name, object payload)
    {
        var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(Path.Combine(dir, name), json + "\n");
    }
}
