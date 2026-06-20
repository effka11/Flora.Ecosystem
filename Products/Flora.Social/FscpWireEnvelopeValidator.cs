using System.Text;
using System.Text.Json;
using Flora.Shared;

namespace Flora.Social;

/// <summary>
/// Серверная проверка формы FSCP wire (без расшифровки), см. docs/fscp/FSCP.md §Server-side validation.
/// </summary>
public static class FscpWireEnvelopeValidator
{
    public const string WirePrefix = "fscp1:";
    public const string BootstrapKeyEpochIdString = "00000000-0000-4000-8000-000000000001";

    private const int MaxWireChars = 200_000;
    private const int MaxInnerUtf8Bytes = 120_000;
    private const int MaxRecipientEnvelopeCipherBytes = 8 * 1024;
    private const int MaxMessageBodyCipherBytes = 64 * 1024;

    private static readonly Guid BootstrapKeyEpochGuid = Guid.Parse(BootstrapKeyEpochIdString);

    public static bool TryValidateDualWire(
        string encryptedForReceiver,
        string encryptedForSender,
        Guid authenticatedSender,
        Guid messageRecipient,
        out string error)
    {
        if (!string.Equals(encryptedForReceiver, encryptedForSender, StringComparison.Ordinal))
        {
            error = "Для FSCP v1 оба ciphertext должны совпадать (один wire на сообщение).";
            return false;
        }

        return TryValidateWire(encryptedForReceiver, authenticatedSender, messageRecipient, out error);
    }

    public static bool TryValidateWire(string wire, Guid authenticatedSender, Guid messageRecipient, out string error)
    {
        error = "";
        if (string.IsNullOrWhiteSpace(wire))
        {
            error = "Пустой FSCP wire.";
            return false;
        }

        wire = wire.Trim();
        if (wire.Length > MaxWireChars)
        {
            error = "FSCP wire слишком длинный.";
            return false;
        }

        if (!wire.StartsWith(WirePrefix, StringComparison.Ordinal))
        {
            error = "Неверный префикс FSCP wire (ожидается fscp1:).";
            return false;
        }

        if (!TryFromBase64Url(wire.AsSpan(WirePrefix.Length), MaxInnerUtf8Bytes, out var jsonUtf8, out error))
            return false;

        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(jsonUtf8);
        }
        catch (JsonException)
        {
            error = "FSCP wire: невалидный JSON.";
            return false;
        }

        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                error = "FSCP wire: корень JSON должен быть объектом.";
                return false;
            }

            if (!TryGetInt(root, "version", out var version) || version != 1)
            {
                error = "FSCP wire: version должен быть 1.";
                return false;
            }

            if (!TryGetGuidString(root, "senderUserUuid", out var sender) || sender != authenticatedSender)
            {
                error = "FSCP wire: senderUserUuid не совпадает с текущим пользователем.";
                return false;
            }

            if (!TryGetGuidString(root, "conversationUuid", out var conversation) ||
                conversation != UuidV5.DmConversationUuid(authenticatedSender, messageRecipient))
            {
                error = "FSCP wire: conversationUuid не соответствует участникам сообщения.";
                return false;
            }

            if (!TryGetGuidString(root, "keyEpochId", out var keyEpoch) || keyEpoch != BootstrapKeyEpochGuid)
            {
                error = "FSCP wire: keyEpochId не поддерживается (ожидается bootstrap v1).";
                return false;
            }

            if (!root.TryGetProperty("recipients", out var recEl) || recEl.ValueKind != JsonValueKind.Array || recEl.GetArrayLength() != 2)
            {
                error = "FSCP wire: recipients должен быть массивом из двух элементов (1:1).";
                return false;
            }

            var seen = new HashSet<Guid>();
            foreach (var r in recEl.EnumerateArray())
            {
                if (r.ValueKind != JsonValueKind.Object)
                {
                    error = "FSCP wire: элемент recipients должен быть объектом.";
                    return false;
                }

                if (!TryGetGuidString(r, "userUuid", out var ru))
                {
                    error = "FSCP wire: неверный userUuid в recipients.";
                    return false;
                }

                seen.Add(ru);
            }

            if (!seen.Contains(authenticatedSender) || !seen.Contains(messageRecipient))
            {
                error = "FSCP wire: recipients должны включать отправителя и получателя.";
                return false;
            }

            foreach (var r in recEl.EnumerateArray())
            {
                if (!TryGetGuidString(r, "userUuid", out var ru))
                    return false;

                if (!r.TryGetProperty("deviceUuid", out var devEl) || devEl.ValueKind != JsonValueKind.String ||
                    string.IsNullOrWhiteSpace(devEl.GetString()))
                {
                    error = "FSCP wire: отсутствует deviceUuid у получателя.";
                    return false;
                }

                if (!Guid.TryParse(devEl.GetString(), out _))
                {
                    error = "FSCP wire: неверный deviceUuid.";
                    return false;
                }

                if (!r.TryGetProperty("recipientKeyEnvelope", out var rk) || rk.ValueKind != JsonValueKind.Object)
                {
                    error = "FSCP wire: отсутствует recipientKeyEnvelope.";
                    return false;
                }

                if (!TryGetInt(rk, "version", out var rkv) || rkv != 1)
                {
                    error = "FSCP wire: recipientKeyEnvelope.version должен быть 1.";
                    return false;
                }

                if (!TryGetString(rk, "algorithm", out var algo) ||
                    !string.Equals(algo, "x25519-hkdf-xchacha20poly1305", StringComparison.Ordinal))
                {
                    error = "FSCP wire: неподдерживаемый алгоритм RKE.";
                    return false;
                }

                if (rk.TryGetProperty("preKeyId", out var pre) && pre.ValueKind is not JsonValueKind.Null)
                {
                    error = "FSCP wire: preKeyId должен быть null в v1.";
                    return false;
                }

                if (!TryGetString(rk, "recipientAgreementPublicKeyId", out var pkIdStr) ||
                    !Guid.TryParse(pkIdStr, out var pkIdGuid))
                {
                    error = "FSCP wire: неверный recipientAgreementPublicKeyId.";
                    return false;
                }

                var expectedPkId = UuidV5.AgreementPublicKeyId(ru, keyEpoch);
                if (pkIdGuid != expectedPkId)
                {
                    error = "FSCP wire: recipientAgreementPublicKeyId не соответствует пользователю и эпохе.";
                    return false;
                }

                if (!TryGetString(rk, "ephemeralPublicKeyBase64Url", out var epk))
                {
                    error = "FSCP wire: нет ephemeralPublicKeyBase64Url.";
                    return false;
                }

                if (!TryFromBase64Url(epk, 64, out var epb, out var errEp))
                {
                    error = errEp;
                    return false;
                }

                if (epb.Length != 32)
                {
                    error = "FSCP wire: неверный ephemeralPublicKeyBase64Url.";
                    return false;
                }

                if (!TryGetString(rk, "saltBase64Url", out var salt))
                {
                    error = "FSCP wire: нет saltBase64Url.";
                    return false;
                }

                if (!TryFromBase64Url(salt, 64, out var saltB, out var errSalt))
                {
                    error = errSalt;
                    return false;
                }

                if (saltB.Length != 32)
                {
                    error = "FSCP wire: неверный saltBase64Url.";
                    return false;
                }

                if (!rk.TryGetProperty("aead", out var aead) || aead.ValueKind != JsonValueKind.Object)
                {
                    error = "FSCP wire: отсутствует aead в recipientKeyEnvelope.";
                    return false;
                }

                if (!TryGetString(aead, "name", out var aeadName) ||
                    !string.Equals(aeadName, "xchacha20-poly1305", StringComparison.Ordinal))
                {
                    error = "FSCP wire: неподдерживаемый AEAD в RKE.";
                    return false;
                }

                if (!TryGetString(aead, "nonceBase64Url", out var nonce))
                {
                    error = "FSCP wire: нет nonce RKE.";
                    return false;
                }

                if (!TryFromBase64Url(nonce, 32, out var nonceB, out var errNonce))
                {
                    error = errNonce;
                    return false;
                }

                if (nonceB.Length != 24)
                {
                    error = "FSCP wire: неверный nonce RKE.";
                    return false;
                }

                if (!TryGetString(rk, "ciphertextBase64Url", out var rct))
                {
                    error = "FSCP wire: нет ciphertext RKE.";
                    return false;
                }

                if (!TryFromBase64Url(rct, MaxRecipientEnvelopeCipherBytes, out var rctB, out var errRct))
                {
                    error = errRct;
                    return false;
                }

                if (rctB.Length < 16)
                {
                    error = "FSCP wire: неверный ciphertext RKE.";
                    return false;
                }
            }

            if (!TryGetString(root, "ciphertextBase64Url", out var bodyCt))
            {
                error = "FSCP wire: нет ciphertext тела сообщения.";
                return false;
            }

            if (!TryFromBase64Url(bodyCt, MaxMessageBodyCipherBytes, out var bodyB, out var errBody))
            {
                error = errBody;
                return false;
            }

            if (bodyB.Length < 16)
            {
                error = "FSCP wire: неверный ciphertext тела сообщения.";
                return false;
            }

            if (!root.TryGetProperty("aead", out var bodyAead) || bodyAead.ValueKind != JsonValueKind.Object)
            {
                error = "FSCP wire: отсутствует верхнеуровневый aead.";
                return false;
            }

            if (!TryGetString(bodyAead, "name", out var baeadName) ||
                !string.Equals(baeadName, "xchacha20-poly1305", StringComparison.Ordinal))
            {
                error = "FSCP wire: неподдерживаемый AEAD тела сообщения.";
                return false;
            }

            if (!TryGetString(bodyAead, "nonceBase64Url", out var bodyNonce))
            {
                error = "FSCP wire: нет nonce тела сообщения.";
                return false;
            }

            if (!TryFromBase64Url(bodyNonce, 32, out var bodyNonceB, out var errBn))
            {
                error = errBn;
                return false;
            }

            if (bodyNonceB.Length != 24)
            {
                error = "FSCP wire: неверный nonce тела сообщения.";
                return false;
            }

            if (!root.TryGetProperty("senderSigningPublicKeyBase64Url", out var signPkEl) ||
                signPkEl.ValueKind != JsonValueKind.String ||
                string.IsNullOrWhiteSpace(signPkEl.GetString()))
            {
                error = "FSCP wire: требуется senderSigningPublicKeyBase64Url (Ed25519, 32 байта).";
                return false;
            }

            if (!TryFromBase64Url(signPkEl.GetString()!, 64, out var signPk, out var errSpk))
            {
                error = errSpk;
                return false;
            }

            if (signPk.Length != 32)
            {
                error = "FSCP wire: неверный senderSigningPublicKeyBase64Url.";
                return false;
            }

            if (!TryGetString(root, "senderSignatureBase64Url", out var sigB64))
            {
                error = "FSCP wire: нет подписи отправителя.";
                return false;
            }

            if (!TryFromBase64Url(sigB64, 96, out var sigBytes, out var errSig))
            {
                error = errSig;
                return false;
            }

            if (sigBytes.Length != 64)
            {
                error = "FSCP wire: неверная подпись отправителя.";
                return false;
            }

            error = "";
            return true;
        }
    }

    /// <summary>
    /// Parses the FSCP wire and extracts the receiver UUID — the participant who is NOT
    /// <paramref name="authenticatedSender"/>. Does not perform full structural validation;
    /// call <see cref="TryValidateDualWire"/> afterwards once the receiver is known.
    /// </summary>
    public static bool TryExtractReceiver(
        string wire,
        Guid authenticatedSender,
        out Guid receiverUuid,
        out string error)
    {
        receiverUuid = Guid.Empty;
        error = "";

        if (string.IsNullOrWhiteSpace(wire) || !wire.TrimStart().StartsWith(WirePrefix, StringComparison.Ordinal))
        {
            error = "Неверный префикс FSCP wire.";
            return false;
        }

        if (!TryFromBase64Url(wire.Trim().AsSpan(WirePrefix.Length), MaxInnerUtf8Bytes, out var jsonUtf8, out error))
            return false;

        JsonDocument doc;
        try { doc = JsonDocument.Parse(jsonUtf8); }
        catch (JsonException) { error = "FSCP wire: невалидный JSON."; return false; }

        using (doc)
        {
            var root = doc.RootElement;

            if (!TryGetGuidString(root, "senderUserUuid", out var sender) || sender != authenticatedSender)
            {
                error = "FSCP wire: senderUserUuid не совпадает с текущим пользователем.";
                return false;
            }

            if (!root.TryGetProperty("recipients", out var recEl) || recEl.ValueKind != JsonValueKind.Array || recEl.GetArrayLength() != 2)
            {
                error = "FSCP wire: recipients должен быть массивом из двух элементов.";
                return false;
            }

            foreach (var r in recEl.EnumerateArray())
            {
                if (!TryGetGuidString(r, "userUuid", out var ru)) continue;
                if (ru != authenticatedSender)
                {
                    receiverUuid = ru;
                    return true;
                }
            }

            error = "FSCP wire: не удалось найти получателя в recipients.";
            return false;
        }
    }

    private static bool TryGetInt(JsonElement o, string name, out int v)
    {
        v = 0;
        return o.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.Number && p.TryGetInt32(out v);
    }

    private static bool TryGetString(JsonElement o, string name, out string s)
    {
        s = "";
        if (!o.TryGetProperty(name, out var p) || p.ValueKind != JsonValueKind.String)
            return false;
        s = p.GetString() ?? "";
        return s.Length > 0;
    }

    private static bool TryGetGuidString(JsonElement o, string name, out Guid g)
    {
        g = default;
        if (!TryGetString(o, name, out var s) || !Guid.TryParse(s, out g))
            return false;
        return true;
    }

    private static bool TryFromBase64Url(ReadOnlySpan<char> chars, int maxDecodedBytes, out byte[] bytes, out string error)
    {
        error = "";
        var s = chars.ToString().Trim().Replace('-', '+').Replace('_', '/');
        switch (s.Length % 4)
        {
            case 2:
                s += "==";
                break;
            case 3:
                s += "=";
                break;
        }

        try
        {
            bytes = Convert.FromBase64String(s);
            if (bytes.Length > maxDecodedBytes)
            {
                error = "Декодированные данные превышают лимит.";
                bytes = Array.Empty<byte>();
                return false;
            }

            error = "";
            return true;
        }
        catch (FormatException)
        {
            error = "Некорректный base64url.";
            bytes = Array.Empty<byte>();
            return false;
        }
    }
}
