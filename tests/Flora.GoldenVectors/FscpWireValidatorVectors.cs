using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Flora.Shared;
using Flora.Social;
using Xunit;

namespace Flora.GoldenVectors;

/// <summary>
/// Golden-вектор серверной валидации FSCP wire (docs/fscp/FSCP.md §Server-side validation,
/// §Test vectors «требование потребления»). Эталон — <see cref="FscpWireEnvelopeValidator"/>;
/// форма валидации заморожена на время миграции (next-architecture.md §4.4), Rust обязан
/// воспроизводить accept/reject и текст ошибки байт-в-байт.
/// Выход: docs/test-vectors/fscp-wire-validator-v1.json (regenerate-only).
/// </summary>
public static class FscpWireValidatorVectorGenerator
{
    public static readonly Guid Sender = Guid.Parse("55555555-5555-4555-8555-555555555555");
    public static readonly Guid Receiver = Guid.Parse("77777777-7777-4777-8777-777777777777");
    public static readonly Guid OtherUser = Guid.Parse("99999999-9999-4999-8999-999999999999");

    private static readonly Guid KeyEpoch = Guid.Parse(FscpWireEnvelopeValidator.BootstrapKeyEpochIdString);
    private const string BootstrapDeviceUuid = "00000000-0000-4000-8000-000000000002";
    private const string MessageUuid = "33333333-3333-4333-8333-333333333333";
    private const string MessageKeyId = "44444444-4444-4444-8444-444444444444";
    private const string CreatedAt = "2026-01-01T00:00:00.000Z";

    public static void Write(string vectorsRootDir)
    {
        Directory.CreateDirectory(vectorsRootDir);
        var json = JsonSerializer.Serialize(BuildVector(), new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(Path.Combine(vectorsRootDir, "fscp-wire-validator-v1.json"), json + "\n");
    }

    public static object BuildVector()
    {
        var cases = new List<object>
        {
            new
            {
                caseId = "valid_baseline",
                description = "Структурно валидный v1 wire (детерминированные байты, крипто-мусор — сервер не расшифровывает)",
                wire = BuildWire(BaselineEnvelope()),
                expectedValid = true,
                expectedExtractedReceiverUuid = Receiver.ToString("d"),
            },
            Negative("empty_wire", "", "Пустой FSCP wire."),
            Negative("wrong_prefix", "fscp2:" + ToB64Url(Encoding.UTF8.GetBytes("{}")), "Неверный префикс FSCP wire (ожидается fscp1:)."),
            Negative("invalid_base64", "fscp1:%%%", "Некорректный base64url."),
            Negative("invalid_json", "fscp1:" + ToB64Url(Encoding.UTF8.GetBytes("not json")), "FSCP wire: невалидный JSON."),
            Mutated("version_2", "FSCP wire: version должен быть 1.",
                e => e["version"] = 2),
            Mutated("conversation_mismatch", "FSCP wire: conversationUuid не соответствует участникам сообщения.",
                e => e["conversationUuid"] = MessageUuid),
            Mutated("wrong_epoch", "FSCP wire: keyEpochId не поддерживается (ожидается bootstrap v1).",
                e => e["keyEpochId"] = "22222222-2222-4222-8222-222222222222"),
            Mutated("one_recipient", "FSCP wire: recipients должен быть массивом из двух элементов (1:1).",
                e => ((JsonArray)e["recipients"]!).RemoveAt(1)),
            Mutated("recipients_missing_receiver", "FSCP wire: recipients должны включать отправителя и получателя.",
                e =>
                {
                    var recipients = (JsonArray)e["recipients"]!;
                    recipients[1] = recipients[0]!.DeepClone();
                }),
            Mutated("prekey_not_null", "FSCP wire: preKeyId должен быть null в v1.",
                e => Rke(e, 0)["preKeyId"] = MessageKeyId),
            Mutated("wrong_agreement_key_id", "FSCP wire: recipientAgreementPublicKeyId не соответствует пользователю и эпохе.",
                e => Rke(e, 0)["recipientAgreementPublicKeyId"] = OtherUser.ToString("d")),
            Mutated("rke_algorithm_unsupported", "FSCP wire: неподдерживаемый алгоритм RKE.",
                e => Rke(e, 0)["algorithm"] = "x25519-hkdf-aesgcm"),
            Mutated("ephemeral_wrong_len", "FSCP wire: неверный ephemeralPublicKeyBase64Url.",
                e => Rke(e, 0)["ephemeralPublicKeyBase64Url"] = ToB64Url(Bytes(31, 0xC0))),
            Mutated("salt_wrong_len", "FSCP wire: неверный saltBase64Url.",
                e => Rke(e, 0)["saltBase64Url"] = ToB64Url(Bytes(16, 0xD0))),
            Mutated("rke_aead_wrong_name", "FSCP wire: неподдерживаемый AEAD в RKE.",
                e => Rke(e, 0)["aead"]!["name"] = "chacha20-poly1305"),
            Mutated("rke_nonce_wrong_len", "FSCP wire: неверный nonce RKE.",
                e => Rke(e, 0)["aead"]!["nonceBase64Url"] = ToB64Url(Bytes(12, 0xE0))),
            Mutated("rke_ciphertext_short", "FSCP wire: неверный ciphertext RKE.",
                e => Rke(e, 0)["ciphertextBase64Url"] = ToB64Url(Bytes(8, 0xF0))),
            Mutated("body_ciphertext_short", "FSCP wire: неверный ciphertext тела сообщения.",
                e => e["ciphertextBase64Url"] = ToB64Url(Bytes(8, 0xA0))),
            Mutated("body_nonce_wrong_len", "FSCP wire: неверный nonce тела сообщения.",
                e => e["aead"]!["nonceBase64Url"] = ToB64Url(Bytes(12, 0xB0))),
            Mutated("missing_signing_pk", "FSCP wire: требуется senderSigningPublicKeyBase64Url (Ed25519, 32 байта).",
                e => e.Remove("senderSigningPublicKeyBase64Url")),
            Mutated("signing_pk_wrong_len", "FSCP wire: неверный senderSigningPublicKeyBase64Url.",
                e => e["senderSigningPublicKeyBase64Url"] = ToB64Url(Bytes(16, 0x11))),
            Mutated("missing_signature", "FSCP wire: нет подписи отправителя.",
                e => e.Remove("senderSignatureBase64Url")),
            Mutated("signature_wrong_len", "FSCP wire: неверная подпись отправителя.",
                e => e["senderSignatureBase64Url"] = ToB64Url(Bytes(32, 0x22))),
            new
            {
                caseId = "sender_mismatch",
                description = "authenticatedSender ≠ senderUserUuid из конверта",
                wire = BuildWire(BaselineEnvelope()),
                authenticatedSenderUuid = Receiver.ToString("d"),
                messageRecipientUuid = Sender.ToString("d"),
                expectedValid = false,
                expectedError = "FSCP wire: senderUserUuid не совпадает с текущим пользователем.",
            },
            new
            {
                caseId = "recipient_arg_mismatch",
                description = "messageRecipient не участвует в conversation → conversationUuid не сходится",
                wire = BuildWire(BaselineEnvelope()),
                authenticatedSenderUuid = Sender.ToString("d"),
                messageRecipientUuid = OtherUser.ToString("d"),
                expectedValid = false,
                expectedError = "FSCP wire: conversationUuid не соответствует участникам сообщения.",
            },
            new
            {
                caseId = "dual_wire_mismatch",
                description = "Legacy dual-ciphertext путь: разные wire для sender/receiver запрещены",
                dual = true,
                encryptedForReceiver = BuildWire(BaselineEnvelope()),
                encryptedForSender = BuildWire(Mutate(BaselineEnvelope(), e => e["messageUuid"] = MessageKeyId)),
                expectedValid = false,
                expectedError = "Для FSCP v1 оба ciphertext должны совпадать (один wire на сообщение).",
            },
        };

        return new
        {
            vectorId = "fscp_wire_validator_v1",
            fscpProtocolVersion = 1,
            messageEnvelopeVersion = 1,
            description = "Позитив и негативы структурной валидации FSCP wire (эталон: Products/Flora.Social/FscpWireEnvelopeValidator.cs). " +
                          "expectedError — точная строка (частота ошибок заморожена вместе с формой валидации, next-architecture.md §4.4).",
            authenticatedSenderUuid = Sender.ToString("d"),
            messageRecipientUuid = Receiver.ToString("d"),
            cases,
        };
    }

    private static object Negative(string caseId, string wire, string expectedError) => new
    {
        caseId,
        wire,
        expectedValid = false,
        expectedError,
    };

    private static object Mutated(string caseId, string expectedError, Action<JsonObject> mutate) => new
    {
        caseId,
        wire = BuildWire(Mutate(BaselineEnvelope(), mutate)),
        expectedValid = false,
        expectedError,
    };

    private static JsonObject Mutate(JsonObject envelope, Action<JsonObject> mutate)
    {
        mutate(envelope);
        return envelope;
    }

    private static JsonObject Rke(JsonObject envelope, int index) =>
        (JsonObject)((JsonArray)envelope["recipients"]!)[index]!["recipientKeyEnvelope"]!;

    private static string BuildWire(JsonObject envelope) =>
        FscpWireEnvelopeValidator.WirePrefix +
        ToB64Url(Encoding.UTF8.GetBytes(envelope.ToJsonString()));

    /// <summary>Ключи в canonical-порядке (FSCP.md §Canonical encoding) — как пишет клиент.</summary>
    private static JsonObject BaselineEnvelope()
    {
        var conversation = UuidV5.DmConversationUuid(Sender, Receiver).ToString("d");
        return new JsonObject
        {
            ["aead"] = new JsonObject
            {
                ["name"] = "xchacha20-poly1305",
                ["nonceBase64Url"] = ToB64Url(Bytes(24, 0xB0)),
            },
            ["ciphertextBase64Url"] = ToB64Url(Bytes(48, 0xA0)),
            ["conversationUuid"] = conversation,
            ["createdAt"] = CreatedAt,
            ["keyEpochId"] = KeyEpoch.ToString("d"),
            ["messageKeyId"] = MessageKeyId,
            ["messageUuid"] = MessageUuid,
            ["recipients"] = new JsonArray(
                RecipientEntry(Sender, seed: 0xC0),
                RecipientEntry(Receiver, seed: 0xC8)),
            ["senderDeviceUuid"] = BootstrapDeviceUuid,
            ["senderSignatureBase64Url"] = ToB64Url(Bytes(64, 0x22)),
            ["senderSigningPublicKeyBase64Url"] = ToB64Url(Bytes(32, 0x11)),
            ["senderUserUuid"] = Sender.ToString("d"),
            ["version"] = 1,
        };
    }

    private static JsonObject RecipientEntry(Guid user, byte seed) => new()
    {
        ["deviceUuid"] = BootstrapDeviceUuid,
        ["recipientKeyEnvelope"] = new JsonObject
        {
            ["aead"] = new JsonObject
            {
                ["name"] = "xchacha20-poly1305",
                ["nonceBase64Url"] = ToB64Url(Bytes(24, (byte)(seed + 2))),
            },
            ["algorithm"] = "x25519-hkdf-xchacha20poly1305",
            ["ciphertextBase64Url"] = ToB64Url(Bytes(48, (byte)(seed + 3))),
            ["ephemeralPublicKeyBase64Url"] = ToB64Url(Bytes(32, seed)),
            ["preKeyId"] = null,
            ["recipientAgreementPublicKeyId"] = UuidV5.AgreementPublicKeyId(user, KeyEpoch).ToString("d"),
            ["saltBase64Url"] = ToB64Url(Bytes(32, (byte)(seed + 1))),
            ["version"] = 1,
        },
        ["userUuid"] = user.ToString("d"),
    };

    private static byte[] Bytes(int length, byte seed)
    {
        var b = new byte[length];
        for (var i = 0; i < length; i++)
            b[i] = (byte)(seed + i);
        return b;
    }

    private static string ToB64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

/// <summary>
/// Consumer golden-вектора fscp-wire-validator-v1.json: каждый case прогоняется через боевой
/// <see cref="FscpWireEnvelopeValidator"/>; результат и текст ошибки — байт-в-байт.
/// </summary>
public sealed class FscpWireValidatorVectorTests
{
    private static string VectorsRootDir =>
        Path.GetFullPath(Path.Combine(
            AppContext.BaseDirectory, "..", "..", "..", "..", "..",
            "docs", "test-vectors"));

    private static string VectorPath => Path.Combine(VectorsRootDir, "fscp-wire-validator-v1.json");

    [Fact]
    public void Generator_writes_fscp_wire_validator_vector_when_env_set()
    {
        if (!string.Equals(Environment.GetEnvironmentVariable("UPDATE_GOLDEN_VECTORS"), "1", StringComparison.Ordinal))
            return;

        FscpWireValidatorVectorGenerator.Write(VectorsRootDir);
        Assert.True(File.Exists(VectorPath));
    }

    [Fact]
    public void Every_vector_case_matches_reference_validator()
    {
        Assert.True(File.Exists(VectorPath), $"Missing golden vector: {VectorPath} (run Scripts/generate-golden-vectors.ps1)");

        using var doc = JsonDocument.Parse(File.ReadAllText(VectorPath));
        var root = doc.RootElement;
        var defaultSender = Guid.Parse(root.GetProperty("authenticatedSenderUuid").GetString()!);
        var defaultRecipient = Guid.Parse(root.GetProperty("messageRecipientUuid").GetString()!);

        foreach (var c in root.GetProperty("cases").EnumerateArray())
        {
            var caseId = c.GetProperty("caseId").GetString();
            var expectedValid = c.GetProperty("expectedValid").GetBoolean();
            var sender = c.TryGetProperty("authenticatedSenderUuid", out var s) ? Guid.Parse(s.GetString()!) : defaultSender;
            var recipient = c.TryGetProperty("messageRecipientUuid", out var r) ? Guid.Parse(r.GetString()!) : defaultRecipient;

            bool valid;
            string error;
            if (c.TryGetProperty("dual", out var dual) && dual.GetBoolean())
            {
                valid = FscpWireEnvelopeValidator.TryValidateDualWire(
                    c.GetProperty("encryptedForReceiver").GetString()!,
                    c.GetProperty("encryptedForSender").GetString()!,
                    sender, recipient, out error);
            }
            else
            {
                valid = FscpWireEnvelopeValidator.TryValidateWire(
                    c.GetProperty("wire").GetString()!, sender, recipient, out error);
            }

            Assert.True(expectedValid == valid, $"{caseId}: expectedValid={expectedValid}, actual={valid}, error='{error}'");
            if (!expectedValid)
                Assert.True(c.GetProperty("expectedError").GetString() == error, $"{caseId}: expectedError mismatch, actual='{error}'");

            if (c.TryGetProperty("expectedExtractedReceiverUuid", out var exr))
            {
                Assert.True(
                    FscpWireEnvelopeValidator.TryExtractReceiver(c.GetProperty("wire").GetString()!, sender, out var extracted, out var exErr),
                    $"{caseId}: TryExtractReceiver failed: {exErr}");
                Assert.Equal(exr.GetString(), extracted.ToString("d"));
            }
        }
    }

    [Fact]
    public void Vector_baseline_stays_deterministic()
    {
        // Регенерация не должна давать дрейф: BuildVector() детерминирован (фиксированные байты, без времени/рандома).
        var a = JsonSerializer.Serialize(FscpWireValidatorVectorGenerator.BuildVector());
        var b = JsonSerializer.Serialize(FscpWireValidatorVectorGenerator.BuildVector());
        Assert.Equal(a, b);
    }
}
