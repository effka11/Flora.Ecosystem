//! Паритет UUID v5/v7 с C# (golden-вектор uuid-v1.json, эталон Flora.Shared).

use flora_parity::{golden_vectors_dir, load_json};
use flora_shared::uuid_v5;
use uuid::Uuid;

fn vector() -> serde_json::Value {
    load_json(&golden_vectors_dir().join("uuid-v1.json")).expect(
        "нет uuid-v1.json — сгенерируйте из C#: ./Scripts/generate-golden-vectors.ps1",
    )
}

#[test]
fn namespace_matches() {
    assert_eq!(
        vector()["namespaceDns"].as_str().unwrap(),
        uuid_v5::FLORA_NAMESPACE_DNS_SCOPE.to_string(),
    );
}

#[test]
fn v5_from_namespace_and_name_matches_csharp() {
    for case in vector()["v5FromNamespaceAndUtf8Name"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let expected = case["expected"].as_str().unwrap();
        let actual =
            uuid_v5::from_namespace_and_utf8_name(&uuid_v5::FLORA_NAMESPACE_DNS_SCOPE, name);
        assert_eq!(actual.to_string(), expected, "name={name:?}");
    }
}

#[test]
fn dm_conversation_uuid_matches_csharp() {
    for case in vector()["dmConversationUuid"].as_array().unwrap() {
        let a: Uuid = case["userA"].as_str().unwrap().parse().unwrap();
        let b: Uuid = case["userB"].as_str().unwrap().parse().unwrap();
        let expected = case["expected"].as_str().unwrap();
        assert_eq!(
            uuid_v5::dm_conversation_uuid(&a, &b).to_string(),
            expected,
            "userA={a} userB={b}",
        );
    }
}

#[test]
fn agreement_public_key_id_matches_csharp() {
    for case in vector()["agreementPublicKeyId"].as_array().unwrap() {
        let user: Uuid = case["userUuid"].as_str().unwrap().parse().unwrap();
        let epoch: Uuid = case["keyEpochId"].as_str().unwrap().parse().unwrap();
        let expected = case["expected"].as_str().unwrap();
        assert_eq!(
            uuid_v5::agreement_public_key_id(&user, &epoch).to_string(),
            expected,
        );
    }
}

#[test]
fn v7_bytes_interpretation_matches_csharp() {
    for case in vector()["v7Samples"].as_array().unwrap() {
        let bytes_hex = case["bytesHex"].as_str().unwrap();
        let expected_string = case["expectedString"].as_str().unwrap();
        let expected_ms = case["unixTimestampMs"].as_i64().unwrap();

        let mut bytes = [0u8; 16];
        for (i, chunk) in bytes_hex.as_bytes().chunks(2).enumerate() {
            bytes[i] = u8::from_str_radix(std::str::from_utf8(chunk).unwrap(), 16).unwrap();
        }
        let parsed = Uuid::from_bytes(bytes);

        assert_eq!(parsed.to_string(), expected_string, "форматирование из байт");
        assert_eq!(parsed.get_version_num(), 7);

        let (secs, nanos) = parsed.get_timestamp().unwrap().to_unix();
        let actual_ms = secs as i64 * 1000 + i64::from(nanos) / 1_000_000;
        assert_eq!(actual_ms, expected_ms, "unix ms из первых 48 бит");
    }
}
