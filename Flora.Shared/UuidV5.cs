using System.Security.Cryptography;
using System.Text;

namespace Flora.Shared;

/// <summary>RFC 4122 UUID v5 (SHA-1), совместимый с пакетом <c>uuid</c> v5 в Apps/Web (namespace + UTF-8 name).</summary>
public static class UuidV5
{
    /// <summary>DNS namespace из RFC; совпадает с <c>uuid.NAMESPACE_DNS</c> / FLORA_UUID_NAMESPACE в <c>lib/fscp/constants.ts</c>.</summary>
    public static readonly Guid FloraNamespaceDnsScope = Guid.Parse("6ba7b810-9dad-11d1-80b4-00c04fd430c8");

    public static Guid FromNamespaceAndUtf8Name(Guid namespaceId, string name) =>
        FromNamespaceAndUtf8Name(namespaceId, Encoding.UTF8.GetBytes(name));

    public static Guid FromNamespaceAndUtf8Name(Guid namespaceId, ReadOnlySpan<byte> nameUtf8)
    {
        var ns = NamespaceAsBigEndian(namespaceId);
        var buf = new byte[ns.Length + nameUtf8.Length];
        ns.CopyTo(buf);
        nameUtf8.CopyTo(buf.AsSpan(ns.Length));
        var hash = SHA1.HashData(buf);
        return GuidV5FromHash16(hash.AsSpan(0, 16));
    }

    /// <summary>Идентификатор DM 1:1 как в <c>dmConversationUuid</c> (TypeScript).</summary>
    public static Guid DmConversationUuid(Guid userA, Guid userB)
    {
        var a = userA.ToString("d");
        var b = userB.ToString("d");
        string x;
        string y;
        if (string.CompareOrdinal(a, b) <= 0)
        {
            x = a;
            y = b;
        }
        else
        {
            x = b;
            y = a;
        }

        return FromNamespaceAndUtf8Name(FloraNamespaceDnsScope, $"{x}|{y}|fscp-dm-v1");
    }

    /// <summary>Идентификатор agreement public key как в <c>agreementPublicKeyId</c> (TypeScript).</summary>
    public static Guid AgreementPublicKeyId(Guid userUuid, Guid keyEpochId)
    {
        var u = userUuid.ToString("d");
        var e = keyEpochId.ToString("d");
        return FromNamespaceAndUtf8Name(FloraNamespaceDnsScope, $"{u}|{e}|agreement-v1");
    }

    private static ReadOnlySpan<byte> NamespaceAsBigEndian(Guid namespaceId)
    {
        var b = namespaceId.ToByteArray();
        return new[]
        {
            b[3], b[2], b[1], b[0],
            b[5], b[4],
            b[7], b[6],
            b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15],
        };
    }

    private static Guid GuidV5FromHash16(ReadOnlySpan<byte> hash16)
    {
        Span<byte> h = stackalloc byte[16];
        hash16.CopyTo(h);
        h[6] = (byte)((h[6] & 0x0F) | (5 << 4));
        h[8] = (byte)((h[8] & 0x3F) | 0x80);
        return new Guid(new byte[]
        {
            h[3], h[2], h[1], h[0],
            h[5], h[4],
            h[7], h[6],
            h[8], h[9], h[10], h[11], h[12], h[13], h[14], h[15],
        });
    }
}
