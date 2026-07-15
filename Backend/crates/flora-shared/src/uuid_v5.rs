//! RFC 4122 UUID v5 (SHA-1). Порт `Flora.Shared/UuidV5.cs`; байтовый паритет с ним
//! и с TS-реализацией (`lib/fscp/deriveIds.ts` в client-core) доказан golden-векторами.

use uuid::Uuid;

/// DNS namespace из RFC; совпадает с `uuid.NAMESPACE_DNS` / `FLORA_UUID_NAMESPACE` (TS)
/// и `UuidV5.FloraNamespaceDnsScope` (C#).
pub const FLORA_NAMESPACE_DNS_SCOPE: Uuid = uuid::uuid!("6ba7b810-9dad-11d1-80b4-00c04fd430c8");

/// Аналог `UuidV5.FromNamespaceAndUtf8Name` (namespace + UTF-8 name).
pub fn from_namespace_and_utf8_name(namespace: &Uuid, name: &str) -> Uuid {
    Uuid::new_v5(namespace, name.as_bytes())
}

/// Идентификатор DM 1:1 — `"{min}|{max}|fscp-dm-v1"`, ordinal-сортировка строковых UUID.
/// Паритет: `UuidV5.DmConversationUuid` (C#) и `dmConversationUuid` (TS).
pub fn dm_conversation_uuid(user_a: &Uuid, user_b: &Uuid) -> Uuid {
    // Uuid::to_string() — всегда lowercase с дефисами (как Guid.ToString("d") и TS toLowerCase),
    // сравнение &str в Rust побайтовое — эквивалент string.CompareOrdinal.
    let a = user_a.to_string();
    let b = user_b.to_string();
    let (x, y) = if a <= b { (a, b) } else { (b, a) };
    from_namespace_and_utf8_name(&FLORA_NAMESPACE_DNS_SCOPE, &format!("{x}|{y}|fscp-dm-v1"))
}

/// Идентификатор agreement public key — `"{user}|{epoch}|agreement-v1"`.
/// Паритет: `UuidV5.AgreementPublicKeyId` (C#) и `agreementPublicKeyId` (TS).
pub fn agreement_public_key_id(user_uuid: &Uuid, key_epoch_id: &Uuid) -> Uuid {
    from_namespace_and_utf8_name(
        &FLORA_NAMESPACE_DNS_SCOPE,
        &format!("{user_uuid}|{key_epoch_id}|agreement-v1"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // Полный паритет со значениями C#/TS проверяется на golden-векторах в Tests/parity;
    // здесь — инварианты самой реализации.

    #[test]
    fn dm_uuid_is_order_independent() {
        let a = uuid::uuid!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        let b = uuid::uuid!("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
        assert_eq!(dm_conversation_uuid(&a, &b), dm_conversation_uuid(&b, &a));
    }

    #[test]
    fn v5_output_has_version_5_and_rfc_variant() {
        let id = from_namespace_and_utf8_name(&FLORA_NAMESPACE_DNS_SCOPE, "flora.example");
        assert_eq!(id.get_version_num(), 5);
        assert_eq!(id.get_variant(), uuid::Variant::RFC4122);
    }
}
